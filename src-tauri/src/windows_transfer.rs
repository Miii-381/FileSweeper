use super::*;

#[derive(Debug, Clone)]
struct PreparedTransfer {
    source_path: PathBuf,
    source_key: String,
    destination_path: PathBuf,
    destination_name: String,
}

fn transfer_path_key(path: &Path) -> String {
    path_string(path).to_ascii_lowercase()
}

fn reserve_unique_destination(
    source: &Path,
    destination_directory: &Path,
    reserved_destinations: &mut HashSet<String>,
) -> Result<PathBuf, String> {
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Unable to determine the source item name.".to_string())?;
    let stem = if source.is_dir() {
        file_name
    } else {
        source
            .file_stem()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Unable to determine the source item stem.".to_string())?
    };
    let extension = if source.is_file() {
        source
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| format!(".{extension}"))
            .unwrap_or_default()
    } else {
        String::new()
    };

    for index in 0..10_000 {
        let candidate_name = if index == 0 {
            file_name.to_string()
        } else {
            format!("{stem} ({index}){extension}")
        };
        let candidate = destination_directory.join(candidate_name);
        let key = transfer_path_key(&candidate);
        if !candidate.exists() && reserved_destinations.insert(key) {
            log::debug!(
                "Windows transfer destination reserved: source={}, target={}, conflict_index={index}",
                path_string(source),
                path_string(&candidate)
            );
            return Ok(candidate);
        }
    }

    Err("Unable to find an available destination item name.".to_string())
}

fn failed_result(source_path: String, error: impl Into<String>) -> FileTaskItemResult {
    FileTaskItemResult {
        source_path,
        destination_path: None,
        status: FileTaskItemStatus::Failed,
        error: Some(error.into()),
    }
}

fn skipped_result(
    source_path: String,
    destination_path: Option<String>,
    reason: impl Into<String>,
) -> FileTaskItemResult {
    FileTaskItemResult {
        source_path,
        destination_path,
        status: FileTaskItemStatus::Skipped,
        error: Some(reason.into()),
    }
}

fn cancelled_result(source_path: String) -> FileTaskItemResult {
    FileTaskItemResult {
        source_path,
        destination_path: None,
        status: FileTaskItemStatus::Cancelled,
        error: None,
    }
}

fn prepare_transfer(
    source: String,
    destination: &Path,
    operation: FileTaskOperation,
    reserved_destinations: &mut HashSet<String>,
) -> Result<PreparedTransfer, FileTaskItemResult> {
    log::debug!(
        "Windows batch transfer validation started: operation={operation:?}, source={source}, destination={}",
        path_string(destination)
    );
    let source_path = fs::canonicalize(&source).map_err(|error| {
        log::warn!(
            "Windows batch transfer source resolution failed: source={source}, error={error}"
        );
        failed_result(source, format!("Unable to access the source item: {error}"))
    })?;
    let normalized_source = path_string(&source_path);
    let metadata = fs::metadata(&source_path).map_err(|error| {
        log::warn!(
            "Windows batch transfer metadata read failed: source={normalized_source}, error={error}"
        );
        failed_result(
            normalized_source.clone(),
            format!("Unable to inspect the source item: {error}"),
        )
    })?;
    if !metadata.is_file() && !metadata.is_dir() {
        log::warn!(
            "Windows batch transfer skipped a non-file-system item: source={normalized_source}"
        );
        return Err(skipped_result(
            normalized_source,
            None,
            "The source is not a regular file or folder.",
        ));
    }
    if file_operations::should_skip_same_directory_transfer(&source_path, destination, operation) {
        log::debug!(
            "Windows batch move skipped an item already in the destination: source={normalized_source}"
        );
        return Err(skipped_result(
            normalized_source,
            Some(path_string(&source_path)),
            "The source is already in the destination folder.",
        ));
    }
    if source_path.is_dir()
        && domain::is_same_or_descendant_path(&path_string(destination), &path_string(&source_path))
    {
        log::warn!(
            "Windows batch transfer rejected a destination inside the source folder: source={}, destination={}",
            normalized_source,
            path_string(destination)
        );
        return Err(failed_result(
            normalized_source,
            "A folder cannot be copied or moved into itself or one of its subfolders.",
        ));
    }

    let destination_path =
        reserve_unique_destination(&source_path, destination, reserved_destinations)
            .map_err(|error| failed_result(normalized_source.clone(), error))?;
    let destination_name = destination_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            failed_result(
                normalized_source.clone(),
                "Unable to determine the destination item name.",
            )
        })?
        .to_string();

    Ok(PreparedTransfer {
        source_key: transfer_path_key(&source_path),
        source_path,
        destination_path,
        destination_name,
    })
}

fn record_task_result(
    control: &FileTaskControl,
    task_id: u64,
    result: FileTaskItemResult,
    stage: &str,
) {
    let status = result.status;
    let source = result.source_path.clone();
    let destination = result.destination_path.clone();
    let error = result.error.clone();
    match control.snapshot.lock() {
        Ok(mut snapshot) => {
            if snapshot.completed_items >= snapshot.total_items {
                log::error!(
                    "Windows batch transfer result ignored because the task is already complete: task_id={task_id}, stage={stage}, source={source}, status={status:?}"
                );
                return;
            }
            snapshot.results.push(result);
            snapshot.completed_items += 1;
            log::log!(
                if status == FileTaskItemStatus::Failed {
                    log::Level::Warn
                } else {
                    log::Level::Debug
                },
                "Windows batch transfer result recorded: task_id={task_id}, stage={stage}, completed={}/{}, status={status:?}, source={source}, destination={}, error={}",
                snapshot.completed_items,
                snapshot.total_items,
                destination.as_deref().unwrap_or("-"),
                error.as_deref().unwrap_or("-")
            );
        }
        Err(_) => {
            log::error!(
                "Windows batch transfer result could not be recorded: task_id={task_id}, stage={stage}, source={source}, status={status:?}"
            );
        }
    }
}

fn shell_item_file_system_path(item: windows::core::Ref<'_, IShellItem>) -> Option<PathBuf> {
    let item = item.as_ref()?;
    let display_name = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH).ok()? };
    let path = unsafe { display_name.to_string().ok().map(PathBuf::from) };
    unsafe { CoTaskMemFree(Some(display_name.0.cast())) };
    path
}

fn hresult_error(operation: FileTaskOperation, status: HRESULT) -> String {
    let action = match operation {
        FileTaskOperation::Copy => "copy",
        FileTaskOperation::Move => "move",
    };
    let message = windows::core::Error::from_hresult(status).message();
    format!(
        "The Windows {action} operation failed (HRESULT 0x{:08X}): {message}",
        status.0 as u32
    )
}

struct WindowsTransferProgressState {
    task_id: u64,
    operation: FileTaskOperation,
    control: FileTaskControl,
    app_handle: tauri::AppHandle,
    plans: HashMap<String, PreparedTransfer>,
    recorded_sources: Mutex<HashSet<String>>,
    last_work_progress: Mutex<(u32, u32)>,
    last_snapshot_emit: Mutex<Instant>,
    started_at: Instant,
    cancellation_signalled: AtomicBool,
    finish_result: Mutex<Option<HRESULT>>,
}

impl WindowsTransferProgressState {
    fn finish_error_message(&self) -> Option<String> {
        match self.finish_result.lock() {
            Ok(result) => result
                .as_ref()
                .copied()
                .filter(|status| !status.is_ok())
                .map(|status| hresult_error(self.operation, status)),
            Err(_) => {
                log::error!(
                    "Windows transfer finish HRESULT could not be read: task_id={}",
                    self.task_id
                );
                Some("Unable to read the final Windows file operation result.".to_string())
            }
        }
    }

    fn emit_progress_if_due(&self) {
        let should_emit = match self.last_snapshot_emit.lock() {
            Ok(mut last_emit) if last_emit.elapsed() >= Duration::from_millis(100) => {
                *last_emit = Instant::now();
                true
            }
            Ok(_) => false,
            Err(_) => {
                log::error!(
                    "Windows transfer progress throttle state is unavailable; emitting defensively: task_id={}",
                    self.task_id
                );
                true
            }
        };
        if should_emit {
            match self.control.snapshot.lock() {
                Ok(snapshot) => log::debug!(
                    "Windows transfer emitting throttled byte-progress snapshot: task_id={}, transferred_bytes={}, total_bytes={}, completed_items={}/{}",
                    self.task_id,
                    snapshot.transferred_bytes,
                    snapshot
                        .total_bytes
                        .map(|total| total.to_string())
                        .unwrap_or_else(|| "unknown".to_string()),
                    snapshot.completed_items,
                    snapshot.total_items
                ),
                Err(_) => log::error!(
                    "Windows transfer byte progress could not be read before emission: task_id={}",
                    self.task_id
                ),
            }
            file_operations::emit_task_snapshot(&self.control, &self.app_handle);
        }
    }

    fn update_byte_progress(
        &self,
        points_current: u64,
        points_total: u64,
        size_current: u64,
        size_total: u64,
        items_current: u64,
        items_total: u64,
    ) {
        log::trace!(
            "Windows transfer byte-progress callback: task_id={}, points={points_current}/{points_total}, bytes={size_current}/{size_total}, shell_items={items_current}/{items_total}",
            self.task_id
        );
        let changed = match self.control.snapshot.lock() {
            Ok(mut snapshot) => {
                let previous_total = snapshot.total_bytes;
                let previous_transferred = snapshot.transferred_bytes;
                let reported_total = size_total.max(size_current);
                if reported_total > 0 {
                    snapshot.total_bytes = Some(
                        snapshot
                            .total_bytes
                            .map_or(reported_total, |total| total.max(reported_total)),
                    );
                }
                snapshot.transferred_bytes = snapshot.transferred_bytes.max(size_current);
                previous_total != snapshot.total_bytes
                    || previous_transferred != snapshot.transferred_bytes
            }
            Err(_) => {
                log::error!(
                    "Windows transfer byte progress could not update the task snapshot: task_id={}",
                    self.task_id
                );
                false
            }
        };
        if changed {
            self.emit_progress_if_due();
        }
    }

    fn operation_status(&self) -> PDOPSTATUS {
        if self.control.cancel.load(Ordering::Acquire) {
            return PDOPS_CANCELLED;
        }
        match self.finish_result.lock() {
            Ok(result) => match result.as_ref() {
                Some(status) if status.is_ok() => PDOPS_STOPPED,
                Some(_) => PDOPS_ERRORS,
                None => PDOPS_RUNNING,
            },
            Err(_) => {
                log::error!(
                    "Windows transfer operation status could not read the finish result: task_id={}",
                    self.task_id
                );
                PDOPS_ERRORS
            }
        }
    }

    fn plan_for_shell_item(
        &self,
        item: windows::core::Ref<'_, IShellItem>,
        callback: &str,
    ) -> Option<PreparedTransfer> {
        let path = shell_item_file_system_path(item);
        let Some(path) = path else {
            log::warn!(
                "Windows transfer callback did not expose a file-system source: task_id={}, callback={callback}",
                self.task_id
            );
            return None;
        };
        let key = transfer_path_key(&path);
        let plan = self.plans.get(&key).cloned();
        if plan.is_none() {
            log::debug!(
                "Windows transfer callback belongs to a nested or unplanned item; leaving top-level progress unchanged: task_id={}, callback={callback}, source={}",
                self.task_id,
                path_string(&path)
            );
        }
        plan
    }

    fn check_cancellation(&self, callback: &str) -> windows::core::Result<()> {
        if !self.control.cancel.load(Ordering::Acquire) {
            return Ok(());
        }
        if !self.cancellation_signalled.swap(true, Ordering::AcqRel) {
            log::info!(
                "Windows transfer cancellation signalled to IFileOperation: task_id={}, callback={callback}",
                self.task_id
            );
        } else {
            log::debug!(
                "Windows transfer cancellation remains active: task_id={}, callback={callback}",
                self.task_id
            );
        }
        Err(windows::core::Error::from_hresult(E_ABORT))
    }

    fn record_post_result(
        &self,
        callback: &str,
        source_item: windows::core::Ref<'_, IShellItem>,
        operation_result: HRESULT,
        newly_created: windows::core::Ref<'_, IShellItem>,
    ) {
        let Some(plan) = self.plan_for_shell_item(source_item, callback) else {
            return;
        };
        let mut recorded = match self.recorded_sources.lock() {
            Ok(recorded) => recorded,
            Err(_) => {
                log::error!(
                    "Windows transfer callback could not access the result registry: task_id={}, callback={callback}, source={}",
                    self.task_id,
                    path_string(&plan.source_path)
                );
                return;
            }
        };
        if !recorded.insert(plan.source_key.clone()) {
            log::warn!(
                "Duplicate Windows transfer completion callback ignored: task_id={}, callback={callback}, source={}",
                self.task_id,
                path_string(&plan.source_path)
            );
            return;
        }
        drop(recorded);

        let reported_destination = shell_item_file_system_path(newly_created).or_else(|| {
            plan.destination_path
                .exists()
                .then(|| plan.destination_path.clone())
        });
        let was_cancelled = self.control.cancel.load(Ordering::Acquire)
            && (operation_result == E_ABORT || !operation_result.is_ok());
        let result = if operation_result.is_ok() {
            FileTaskItemResult {
                source_path: path_string(&plan.source_path),
                destination_path: Some(path_string(
                    reported_destination
                        .as_deref()
                        .unwrap_or(&plan.destination_path),
                )),
                status: FileTaskItemStatus::Completed,
                error: None,
            }
        } else if was_cancelled {
            FileTaskItemResult {
                source_path: path_string(&plan.source_path),
                destination_path: reported_destination.as_deref().map(path_string),
                status: FileTaskItemStatus::Cancelled,
                error: None,
            }
        } else {
            FileTaskItemResult {
                source_path: path_string(&plan.source_path),
                destination_path: reported_destination.as_deref().map(path_string),
                status: FileTaskItemStatus::Failed,
                error: Some(hresult_error(self.operation, operation_result)),
            }
        };
        log::debug!(
            "Windows transfer post callback classified: task_id={}, callback={callback}, hresult=0x{:08X}, source={}, requested_target={}, reported_target={}, status={:?}",
            self.task_id,
            operation_result.0 as u32,
            path_string(&plan.source_path),
            path_string(&plan.destination_path),
            reported_destination
                .as_deref()
                .map(path_string)
                .unwrap_or_else(|| "-".to_string()),
            result.status
        );
        record_task_result(&self.control, self.task_id, result, callback);
        self.emit_progress_if_due();
    }

    fn mark_recorded(&self, source_key: &str) {
        match self.recorded_sources.lock() {
            Ok(mut recorded) => {
                recorded.insert(source_key.to_string());
            }
            Err(_) => log::error!(
                "Windows transfer could not mark a queue-time result as recorded: task_id={}, source_key={source_key}",
                self.task_id
            ),
        }
    }

    fn finalize_unreported(
        &self,
        user_cancelled: bool,
        operations_aborted: bool,
        perform_error: Option<&str>,
    ) {
        let unreported = match self.recorded_sources.lock() {
            Ok(recorded) => self
                .plans
                .values()
                .filter(|plan| !recorded.contains(&plan.source_key))
                .cloned()
                .collect::<Vec<_>>(),
            Err(_) => {
                log::error!(
                    "Windows transfer finalization could not access the result registry: task_id={}",
                    self.task_id
                );
                self.plans.values().cloned().collect()
            }
        };
        log::debug!(
            "Windows transfer finalizing unreported top-level items: task_id={}, count={}, user_cancelled={user_cancelled}, operations_aborted={operations_aborted}, perform_error={}",
            self.task_id,
            unreported.len(),
            perform_error.unwrap_or("-")
        );

        for plan in unreported {
            self.mark_recorded(&plan.source_key);
            let target_exists = plan.destination_path.exists();
            let source_exists = plan.source_path.exists();
            let result = if user_cancelled {
                cancelled_result(path_string(&plan.source_path))
            } else if perform_error.is_none()
                && !operations_aborted
                && target_exists
                && (self.operation == FileTaskOperation::Copy || !source_exists)
            {
                log::warn!(
                    "Windows transfer inferred a successful top-level result after a missing callback: task_id={}, source={}, target={}",
                    self.task_id,
                    path_string(&plan.source_path),
                    path_string(&plan.destination_path)
                );
                FileTaskItemResult {
                    source_path: path_string(&plan.source_path),
                    destination_path: Some(path_string(&plan.destination_path)),
                    status: FileTaskItemStatus::Completed,
                    error: None,
                }
            } else {
                let reason = perform_error.map(str::to_string).unwrap_or_else(|| {
                    if operations_aborted {
                        "Windows stopped the batch before this item reported completion."
                            .to_string()
                    } else {
                        "Windows finished the batch without reporting a result for this item."
                            .to_string()
                    }
                });
                FileTaskItemResult {
                    source_path: path_string(&plan.source_path),
                    destination_path: target_exists.then(|| path_string(&plan.destination_path)),
                    status: FileTaskItemStatus::Failed,
                    error: Some(reason),
                }
            };
            record_task_result(&self.control, self.task_id, result, "finalize-unreported");
        }
    }
}

#[windows::core::implement(IOperationsProgressDialog)]
struct WindowsTransferByteProgressDialog {
    state: Arc<WindowsTransferProgressState>,
}

#[allow(non_snake_case)]
impl IOperationsProgressDialog_Impl for WindowsTransferByteProgressDialog_Impl {
    fn StartProgressDialog(&self, _hwndowner: HWND, flags: u32) -> windows::core::Result<()> {
        log::info!(
            "Windows headless byte-progress receiver started: task_id={}, flags=0x{flags:X}",
            self.state.task_id
        );
        Ok(())
    }

    fn StopProgressDialog(&self) -> windows::core::Result<()> {
        log::info!(
            "Windows headless byte-progress receiver stopped: task_id={}",
            self.state.task_id
        );
        Ok(())
    }

    fn SetOperation(&self, action: SPACTION) -> windows::core::Result<()> {
        log::trace!(
            "Windows byte-progress operation changed: task_id={}, shell_action={:?}",
            self.state.task_id,
            action
        );
        Ok(())
    }

    fn SetMode(&self, mode: u32) -> windows::core::Result<()> {
        log::trace!(
            "Windows byte-progress mode changed: task_id={}, mode=0x{mode:X}",
            self.state.task_id
        );
        Ok(())
    }

    fn UpdateProgress(
        &self,
        ullpointscurrent: u64,
        ullpointstotal: u64,
        ullsizecurrent: u64,
        ullsizetotal: u64,
        ullitemscurrent: u64,
        ullitemstotal: u64,
    ) -> windows::core::Result<()> {
        self.state.update_byte_progress(
            ullpointscurrent,
            ullpointstotal,
            ullsizecurrent,
            ullsizetotal,
            ullitemscurrent,
            ullitemstotal,
        );
        self.state
            .check_cancellation("IOperationsProgressDialog::UpdateProgress")
    }

    fn UpdateLocations(
        &self,
        _psisource: windows::core::Ref<'_, IShellItem>,
        _psitarget: windows::core::Ref<'_, IShellItem>,
        _psiitem: windows::core::Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        log::trace!(
            "Windows byte-progress locations changed: task_id={}",
            self.state.task_id
        );
        Ok(())
    }

    fn ResetTimer(&self) -> windows::core::Result<()> {
        log::trace!(
            "Windows byte-progress timer reset: task_id={}",
            self.state.task_id
        );
        Ok(())
    }

    fn PauseTimer(&self) -> windows::core::Result<()> {
        log::trace!(
            "Windows byte-progress timer paused: task_id={}",
            self.state.task_id
        );
        Ok(())
    }

    fn ResumeTimer(&self) -> windows::core::Result<()> {
        log::trace!(
            "Windows byte-progress timer resumed: task_id={}",
            self.state.task_id
        );
        Ok(())
    }

    fn GetMilliseconds(
        &self,
        pullelapsed: *mut u64,
        pullremaining: *mut u64,
    ) -> windows::core::Result<()> {
        let elapsed =
            u64::try_from(self.state.started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
        unsafe {
            if let Some(elapsed_output) = pullelapsed.as_mut() {
                *elapsed_output = elapsed;
            }
            if let Some(remaining_output) = pullremaining.as_mut() {
                *remaining_output = 0;
            }
        }
        log::trace!(
            "Windows byte-progress elapsed time requested: task_id={}, elapsed_ms={elapsed}",
            self.state.task_id
        );
        Ok(())
    }

    fn GetOperationStatus(&self) -> windows::core::Result<PDOPSTATUS> {
        let status = self.state.operation_status();
        log::trace!(
            "Windows byte-progress operation status requested: task_id={}, status={:?}",
            self.state.task_id,
            status
        );
        Ok(status)
    }
}

#[windows::core::implement(IFileOperationProgressSink)]
struct WindowsTransferProgressSink {
    state: Arc<WindowsTransferProgressState>,
}

#[allow(non_snake_case)]
impl IFileOperationProgressSink_Impl for WindowsTransferProgressSink_Impl {
    fn StartOperations(&self) -> windows::core::Result<()> {
        log::info!(
            "Windows IFileOperation started executing the queued batch: task_id={}, operation={:?}, planned_items={}",
            self.state.task_id,
            self.state.operation,
            self.state.plans.len()
        );
        self.state.check_cancellation("StartOperations")
    }

    fn FinishOperations(&self, hrresult: HRESULT) -> windows::core::Result<()> {
        log::info!(
            "Windows IFileOperation finished the queued batch: task_id={}, hresult=0x{:08X}",
            self.state.task_id,
            hrresult.0 as u32
        );
        match self.state.finish_result.lock() {
            Ok(mut result) => *result = Some(hrresult),
            Err(_) => log::error!(
                "Windows transfer finish HRESULT could not be recorded: task_id={}",
                self.state.task_id
            ),
        }
        Ok(())
    }

    fn PreRenameItem(
        &self,
        _dwflags: u32,
        _psiitem: windows::core::Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
    ) -> windows::core::Result<()> {
        self.state.check_cancellation("PreRenameItem")
    }

    fn PostRenameItem(
        &self,
        _dwflags: u32,
        _psiitem: windows::core::Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
        _hrrename: HRESULT,
        _psinewlycreated: windows::core::Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        self.state.check_cancellation("PostRenameItem")
    }

    fn PreMoveItem(
        &self,
        dwflags: u32,
        psiitem: windows::core::Ref<'_, IShellItem>,
        _psidestinationfolder: windows::core::Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
    ) -> windows::core::Result<()> {
        let source = shell_item_file_system_path(psiitem)
            .as_deref()
            .map(path_string)
            .unwrap_or_else(|| "-".to_string());
        log::debug!(
            "Windows transfer PreMoveItem: task_id={}, flags=0x{dwflags:X}, source={source}",
            self.state.task_id
        );
        self.state.check_cancellation("PreMoveItem")
    }

    fn PostMoveItem(
        &self,
        _dwflags: u32,
        psiitem: windows::core::Ref<'_, IShellItem>,
        _psidestinationfolder: windows::core::Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
        hrmove: HRESULT,
        psinewlycreated: windows::core::Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        self.state
            .record_post_result("PostMoveItem", psiitem, hrmove, psinewlycreated);
        self.state.check_cancellation("PostMoveItem")
    }

    fn PreCopyItem(
        &self,
        dwflags: u32,
        psiitem: windows::core::Ref<'_, IShellItem>,
        _psidestinationfolder: windows::core::Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
    ) -> windows::core::Result<()> {
        let source = shell_item_file_system_path(psiitem)
            .as_deref()
            .map(path_string)
            .unwrap_or_else(|| "-".to_string());
        log::debug!(
            "Windows transfer PreCopyItem: task_id={}, flags=0x{dwflags:X}, source={source}",
            self.state.task_id
        );
        self.state.check_cancellation("PreCopyItem")
    }

    fn PostCopyItem(
        &self,
        _dwflags: u32,
        psiitem: windows::core::Ref<'_, IShellItem>,
        _psidestinationfolder: windows::core::Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
        hrcopy: HRESULT,
        psinewlycreated: windows::core::Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        self.state
            .record_post_result("PostCopyItem", psiitem, hrcopy, psinewlycreated);
        self.state.check_cancellation("PostCopyItem")
    }

    fn PreDeleteItem(
        &self,
        _dwflags: u32,
        _psiitem: windows::core::Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        self.state.check_cancellation("PreDeleteItem")
    }

    fn PostDeleteItem(
        &self,
        _dwflags: u32,
        _psiitem: windows::core::Ref<'_, IShellItem>,
        _hrdelete: HRESULT,
        _psinewlycreated: windows::core::Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        self.state.check_cancellation("PostDeleteItem")
    }

    fn PreNewItem(
        &self,
        _dwflags: u32,
        _psidestinationfolder: windows::core::Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
    ) -> windows::core::Result<()> {
        self.state.check_cancellation("PreNewItem")
    }

    fn PostNewItem(
        &self,
        _dwflags: u32,
        _psidestinationfolder: windows::core::Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
        _psztemplatename: &PCWSTR,
        _dwfileattributes: u32,
        _hrnew: HRESULT,
        _psinewitem: windows::core::Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        self.state.check_cancellation("PostNewItem")
    }

    fn UpdateProgress(&self, iworktotal: u32, iworksofar: u32) -> windows::core::Result<()> {
        match self.state.last_work_progress.lock() {
            Ok(mut previous) if *previous != (iworktotal, iworksofar) => {
                log::debug!(
                    "Windows transfer work-point progress: task_id={}, work_so_far={iworksofar}, work_total={iworktotal}",
                    self.state.task_id
                );
                *previous = (iworktotal, iworksofar);
            }
            Ok(_) => {}
            Err(_) => log::error!(
                "Windows transfer work-point progress could not be recorded: task_id={}",
                self.state.task_id
            ),
        }
        self.state.check_cancellation("UpdateProgress")
    }

    fn ResetTimer(&self) -> windows::core::Result<()> {
        log::debug!(
            "Windows transfer timer reset callback received: task_id={}",
            self.state.task_id
        );
        Ok(())
    }

    fn PauseTimer(&self) -> windows::core::Result<()> {
        log::debug!(
            "Windows transfer timer pause callback received: task_id={}",
            self.state.task_id
        );
        Ok(())
    }

    fn ResumeTimer(&self) -> windows::core::Result<()> {
        log::debug!(
            "Windows transfer timer resume callback received: task_id={}",
            self.state.task_id
        );
        Ok(())
    }
}

fn all_task_items_completed(snapshot: &FileTaskSnapshot) -> bool {
    snapshot.results.len() == snapshot.total_items
        && snapshot
            .results
            .iter()
            .all(|result| result.status == FileTaskItemStatus::Completed)
}

fn set_terminal_state(
    control: &FileTaskControl,
    app_handle: &tauri::AppHandle,
    task_id: u64,
    user_cancelled: bool,
) -> bool {
    let all_completed = match control.snapshot.lock() {
        Ok(mut snapshot) => {
            snapshot.state = if user_cancelled {
                FileTaskState::Cancelled
            } else {
                FileTaskState::Completed
            };
            let completed_every_item = all_task_items_completed(&snapshot);
            if completed_every_item {
                if let Some(total_bytes) = snapshot.total_bytes {
                    snapshot.transferred_bytes = total_bytes;
                }
            }
            let succeeded = snapshot
                .results
                .iter()
                .filter(|result| result.status == FileTaskItemStatus::Completed)
                .count();
            let skipped = snapshot
                .results
                .iter()
                .filter(|result| result.status == FileTaskItemStatus::Skipped)
                .count();
            let failed = snapshot
                .results
                .iter()
                .filter(|result| result.status == FileTaskItemStatus::Failed)
                .count();
            let cancelled = snapshot
                .results
                .iter()
                .filter(|result| result.status == FileTaskItemStatus::Cancelled)
                .count();
            log::info!(
                "Windows batch file task reached terminal state: task_id={task_id}, state={:?}, succeeded={succeeded}, skipped={skipped}, failed={failed}, cancelled={cancelled}, total={}, transferred_bytes={}, total_bytes={}",
                snapshot.state,
                snapshot.total_items,
                snapshot.transferred_bytes,
                snapshot
                    .total_bytes
                    .map(|total| total.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            );
            completed_every_item
        }
        Err(_) => {
            log::error!(
                "Windows batch file task terminal state could not be recorded: task_id={task_id}"
            );
            false
        }
    };
    file_operations::emit_task_snapshot(control, app_handle);
    all_completed
}

pub(super) fn run_transfer_task(
    control: FileTaskControl,
    paths: Vec<String>,
    destination: PathBuf,
    operation: FileTaskOperation,
    app_handle: tauri::AppHandle,
    clipboard_reporter: Option<ClipboardPasteReporter>,
) {
    let task_id = control
        .snapshot
        .lock()
        .map(|snapshot| snapshot.id)
        .unwrap_or_else(|_| {
            log::error!("Unable to read Windows batch file task id; using diagnostic id zero");
            0
        });
    log::info!(
        "Windows batch file task started on STA queue: task_id={task_id}, operation={operation:?}, requested_items={}, destination={}",
        paths.len(),
        path_string(&destination)
    );
    if let Ok(mut snapshot) = control.snapshot.lock() {
        snapshot.state = FileTaskState::Running;
    } else {
        log::error!("Unable to mark Windows batch file task as running: task_id={task_id}");
    }
    file_operations::emit_task_snapshot(&control, &app_handle);

    let mut reserved_destinations = HashSet::new();
    let mut prepared = Vec::with_capacity(paths.len());
    for (index, source) in paths.into_iter().enumerate() {
        if control.cancel.load(Ordering::Acquire) {
            log::info!(
                "Windows batch file task cancelled during validation: task_id={task_id}, next_item={}, source={source}",
                index + 1
            );
            record_task_result(
                &control,
                task_id,
                cancelled_result(source),
                "validation-cancelled",
            );
            continue;
        }
        match prepare_transfer(source, &destination, operation, &mut reserved_destinations) {
            Ok(plan) => prepared.push(plan),
            Err(result) => record_task_result(&control, task_id, result, "validation"),
        }
    }

    let plans = prepared
        .iter()
        .map(|plan| (plan.source_key.clone(), plan.clone()))
        .collect::<HashMap<_, _>>();
    let state = Arc::new(WindowsTransferProgressState {
        task_id,
        operation,
        control: control.clone(),
        app_handle: app_handle.clone(),
        plans,
        recorded_sources: Mutex::new(HashSet::new()),
        last_work_progress: Mutex::new((0, 0)),
        last_snapshot_emit: Mutex::new(
            Instant::now()
                .checked_sub(Duration::from_millis(100))
                .unwrap_or_else(Instant::now),
        ),
        started_at: Instant::now(),
        cancellation_signalled: AtomicBool::new(false),
        finish_result: Mutex::new(None),
    });

    if prepared.is_empty() || control.cancel.load(Ordering::Acquire) {
        state.finalize_unreported(control.cancel.load(Ordering::Acquire), false, None);
        set_terminal_state(
            &control,
            &app_handle,
            task_id,
            control.cancel.load(Ordering::Acquire),
        );
        return;
    }

    let operation_instance = match file_operations::shell_file_operation() {
        Ok(operation_instance) => operation_instance,
        Err(error) => {
            log::error!(
                "Windows batch file operation could not be created: task_id={task_id}, error={error}"
            );
            state.finalize_unreported(false, false, Some(&error));
            set_terminal_state(&control, &app_handle, task_id, false);
            return;
        }
    };
    let transfer_flags = file_operations::background_shell_transfer_flags();
    if let Err(error) = unsafe { operation_instance.SetOperationFlags(transfer_flags) } {
        let message = format!("Unable to configure the Windows transfer collision policy: {error}");
        log::error!(
            "Windows batch transfer flags could not be configured: task_id={task_id}, flags=0x{:X}, error={error}",
            transfer_flags.0
        );
        state.finalize_unreported(false, false, Some(&message));
        set_terminal_state(&control, &app_handle, task_id, false);
        return;
    }
    log::debug!(
        "Windows batch transfer flags configured: task_id={task_id}, flags=0x{:X}, rename_on_collision=true, native_progress_receiver=custom, native_error_ui=false",
        transfer_flags.0
    );
    let byte_progress_dialog: IOperationsProgressDialog = WindowsTransferByteProgressDialog {
        state: state.clone(),
    }
    .into();
    let _byte_progress_dialog = match unsafe {
        operation_instance.SetProgressDialog(&byte_progress_dialog)
    } {
        Ok(()) => {
            log::info!("Windows headless byte-progress receiver attached: task_id={task_id}");
            Some(byte_progress_dialog)
        }
        Err(error) => {
            log::warn!(
                "Windows headless byte-progress receiver could not be attached; restoring silent transfer mode before falling back to item completion: task_id={task_id}, error={error}"
            );
            let fallback_flags = transfer_flags | FOF_SILENT;
            if let Err(fallback_error) =
                unsafe { operation_instance.SetOperationFlags(fallback_flags) }
            {
                let message = format!(
                    "Unable to restore silent Windows transfer mode after byte-progress setup failed: {fallback_error}"
                );
                log::error!(
                    "Windows batch transfer aborted because neither custom nor silent progress mode could be guaranteed: task_id={task_id}, flags=0x{:X}, error={fallback_error}",
                    fallback_flags.0
                );
                state.finalize_unreported(false, false, Some(&message));
                set_terminal_state(&control, &app_handle, task_id, false);
                return;
            }
            log::info!(
                "Windows batch transfer silent fallback configured: task_id={task_id}, flags=0x{:X}",
                fallback_flags.0
            );
            None
        }
    };
    let destination_item = match file_operations::shell_item(&destination) {
        Ok(destination_item) => destination_item,
        Err(error) => {
            log::error!(
                "Windows batch destination Shell item could not be created: task_id={task_id}, destination={}, error={error}",
                path_string(&destination)
            );
            state.finalize_unreported(false, false, Some(&error));
            set_terminal_state(&control, &app_handle, task_id, false);
            return;
        }
    };

    let owner = app_handle
        .get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
        .map(|handle| handle.0 as isize)
        .unwrap_or_default();
    if owner != 0 {
        if let Err(error) =
            unsafe { operation_instance.SetOwnerWindow(HWND(owner as *mut std::ffi::c_void)) }
        {
            log::warn!(
                "Windows batch file operation owner window could not be set; continuing in silent mode: task_id={task_id}, owner=0x{owner:X}, error={error}"
            );
        } else {
            log::debug!(
                "Windows batch file operation owner window configured: task_id={task_id}, owner=0x{owner:X}"
            );
        }
    } else {
        log::warn!(
            "Windows batch file operation has no owner window handle; continuing in silent mode: task_id={task_id}"
        );
    }

    let sink: IFileOperationProgressSink = WindowsTransferProgressSink {
        state: state.clone(),
    }
    .into();
    let advise_cookie = match unsafe { operation_instance.Advise(&sink) } {
        Ok(cookie) => {
            log::debug!("Windows batch progress sink advised: task_id={task_id}, cookie={cookie}");
            cookie
        }
        Err(error) => {
            let message =
                format!("Unable to subscribe to Windows file operation progress: {error}");
            log::error!(
                "Windows batch progress sink advise failed: task_id={task_id}, error={error}"
            );
            state.finalize_unreported(false, false, Some(&message));
            set_terminal_state(&control, &app_handle, task_id, false);
            return;
        }
    };

    let mut queued_items = 0_usize;
    for (index, plan) in prepared.iter().enumerate() {
        if control.cancel.load(Ordering::Acquire) {
            log::info!(
                "Windows batch queueing stopped by cancellation: task_id={task_id}, queued={queued_items}, remaining={}",
                prepared.len() - index
            );
            break;
        }
        let source_item = match file_operations::shell_item(&plan.source_path) {
            Ok(source_item) => source_item,
            Err(error) => {
                state.mark_recorded(&plan.source_key);
                record_task_result(
                    &control,
                    task_id,
                    failed_result(path_string(&plan.source_path), error),
                    "queue-source",
                );
                continue;
            }
        };
        let destination_name = HSTRING::from(&plan.destination_name);
        let queue_result = unsafe {
            match operation {
                FileTaskOperation::Copy => operation_instance.CopyItem(
                    &source_item,
                    &destination_item,
                    PCWSTR(destination_name.as_ptr()),
                    None,
                ),
                FileTaskOperation::Move => operation_instance.MoveItem(
                    &source_item,
                    &destination_item,
                    PCWSTR(destination_name.as_ptr()),
                    None,
                ),
            }
        };
        match queue_result {
            Ok(()) => {
                queued_items += 1;
                log::debug!(
                    "Windows batch item queued: task_id={task_id}, operation={operation:?}, item={}/{}, source={}, target={}",
                    index + 1,
                    prepared.len(),
                    path_string(&plan.source_path),
                    path_string(&plan.destination_path)
                );
            }
            Err(error) => {
                state.mark_recorded(&plan.source_key);
                record_task_result(
                    &control,
                    task_id,
                    failed_result(
                        path_string(&plan.source_path),
                        format!("Unable to queue the Windows file operation: {error}"),
                    ),
                    "queue-operation",
                );
            }
        }
    }

    file_operations::emit_task_snapshot(&control, &app_handle);

    let mut perform_error = None;
    let mut operations_aborted = false;
    if queued_items > 0 && !control.cancel.load(Ordering::Acquire) {
        log::info!(
            "Executing one Windows IFileOperation batch: task_id={task_id}, operation={operation:?}, queued_items={queued_items}, requested_items={} ",
            prepared.len()
        );
        if let Err(error) = unsafe { operation_instance.PerformOperations() } {
            let message = format!("Unable to execute the Windows file operation batch: {error}");
            log::error!(
                "Windows IFileOperation PerformOperations failed: task_id={task_id}, error={error}"
            );
            perform_error = Some(message);
        }
        if perform_error.is_none() {
            if let Some(error) = state.finish_error_message() {
                log::warn!(
                    "Windows IFileOperation FinishOperations reported a failure: task_id={task_id}, error={error}"
                );
                perform_error = Some(error);
            }
        }
        match unsafe { operation_instance.GetAnyOperationsAborted() } {
            Ok(aborted) => {
                operations_aborted = aborted.as_bool();
                log::info!(
                    "Windows IFileOperation abort state read: task_id={task_id}, aborted={operations_aborted}, user_cancel_requested={}",
                    control.cancel.load(Ordering::Acquire)
                );
            }
            Err(error) => {
                log::error!(
                    "Windows IFileOperation abort state could not be read: task_id={task_id}, error={error}"
                );
                if perform_error.is_none() {
                    perform_error = Some(format!(
                        "Unable to inspect whether Windows aborted the file operation: {error}"
                    ));
                }
            }
        }
    } else {
        log::info!(
            "Windows IFileOperation batch execution skipped: task_id={task_id}, queued_items={queued_items}, user_cancel_requested={}",
            control.cancel.load(Ordering::Acquire)
        );
    }

    if let Err(error) = unsafe { operation_instance.Unadvise(advise_cookie) } {
        log::warn!(
            "Windows batch progress sink unadvise failed: task_id={task_id}, cookie={advise_cookie}, error={error}"
        );
    } else {
        log::debug!(
            "Windows batch progress sink unadvised: task_id={task_id}, cookie={advise_cookie}"
        );
    }

    let user_cancelled = control.cancel.load(Ordering::Acquire);
    state.finalize_unreported(user_cancelled, operations_aborted, perform_error.as_deref());
    let all_completed = set_terminal_state(&control, &app_handle, task_id, user_cancelled);
    if let Some(reporter) = clipboard_reporter {
        if all_completed {
            log::info!(
                "Windows clipboard-originated task completed fully; scheduling Shell completion report: task_id={task_id}, operation={operation:?}, expected_sequence={}",
                reporter.expected_sequence
            );
            file_operations::report_completed_clipboard_paste(reporter, operation);
        } else {
            log::info!(
                "Windows clipboard-originated task was not fully successful; Shell completion report suppressed: task_id={task_id}, operation={operation:?}, expected_sequence={}",
                reporter.expected_sequence
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_test_directory(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "file-sweeper-windows-transfer-{label}-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn batch_destination_reservations_prevent_intra_task_name_collisions() {
        let root = temporary_test_directory("reservations");
        let source_one_directory = root.join("source-one");
        let source_two_directory = root.join("source-two");
        let destination = root.join("destination");
        fs::create_dir_all(&source_one_directory).unwrap();
        fs::create_dir_all(&source_two_directory).unwrap();
        fs::create_dir_all(&destination).unwrap();
        let source_one = source_one_directory.join("clip.mp4");
        let source_two = source_two_directory.join("clip.mp4");
        fs::write(&source_one, b"one").unwrap();
        fs::write(&source_two, b"two").unwrap();
        let mut reserved = HashSet::new();

        let first = reserve_unique_destination(&source_one, &destination, &mut reserved).unwrap();
        let second = reserve_unique_destination(&source_two, &destination, &mut reserved).unwrap();

        assert_eq!(first, destination.join("clip.mp4"));
        assert_eq!(second, destination.join("clip (1).mp4"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn directory_conflict_names_keep_the_complete_directory_name() {
        let root = temporary_test_directory("directory-name");
        let source_parent = root.join("source");
        let destination = root.join("destination");
        let source = source_parent.join("archive.2026");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(destination.join("archive.2026")).unwrap();
        let mut reserved = HashSet::new();

        let target = reserve_unique_destination(&source, &destination, &mut reserved).unwrap();

        assert_eq!(target, destination.join("archive.2026 (1)"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn same_directory_move_is_rejected_during_batch_preparation() {
        let root = temporary_test_directory("same-directory-move");
        let source = root.join("clip.mp4");
        fs::write(&source, b"video").unwrap();
        let mut reserved = HashSet::new();

        let result = prepare_transfer(
            path_string(&source),
            &root,
            FileTaskOperation::Move,
            &mut reserved,
        )
        .unwrap_err();

        assert_eq!(result.status, FileTaskItemStatus::Skipped);
        assert_eq!(result.destination_path, Some(path_string(&source)));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clipboard_completion_requires_every_item_to_finish_successfully() {
        let completed = FileTaskItemResult {
            source_path: r"D:\source\a.txt".to_string(),
            destination_path: Some(r"D:\target\a.txt".to_string()),
            status: FileTaskItemStatus::Completed,
            error: None,
        };
        let mut snapshot = FileTaskSnapshot {
            id: 1,
            operation: FileTaskOperation::Move,
            state: FileTaskState::Completed,
            destination_path: r"D:\target".to_string(),
            total_items: 2,
            completed_items: 2,
            total_bytes: Some(2),
            transferred_bytes: 2,
            results: vec![completed.clone(), completed],
        };

        assert!(all_task_items_completed(&snapshot));

        snapshot.results[1].status = FileTaskItemStatus::Skipped;
        assert!(!all_task_items_completed(&snapshot));

        snapshot.results.pop();
        assert!(!all_task_items_completed(&snapshot));
    }
}
