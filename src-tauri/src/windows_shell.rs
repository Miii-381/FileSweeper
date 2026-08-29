use super::*;
#[cfg(target_os = "windows")]
#[windows::core::implement(IDropSource)]
struct WindowsFileDragSource;

#[cfg(target_os = "windows")]
impl WindowsFileDragSource {
    fn new() -> Self {
        Self
    }
}

#[cfg(target_os = "windows")]
impl IDropSource_Impl for WindowsFileDragSource_Impl {
    fn QueryContinueDrag(
        &self,
        escape_pressed: windows::core::BOOL,
        key_state: MODIFIERKEYS_FLAGS,
    ) -> HRESULT {
        if escape_pressed.as_bool() {
            DRAGDROP_S_CANCEL
        } else if key_state.0 & MK_LBUTTON.0 == 0 {
            DRAGDROP_S_DROP
        } else {
            S_OK
        }
    }

    fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

#[cfg(target_os = "windows")]
thread_local! {
    static LIVE_FILE_CLIPBOARD_OBJECT: std::cell::RefCell<Option<IDataObject>> = const {
        std::cell::RefCell::new(None)
    };
}

#[cfg(target_os = "windows")]
#[link(name = "ole32")]
extern "system" {
    #[link_name = "OleIsCurrentClipboard"]
    fn ole_is_current_clipboard(data_object: *mut std::ffi::c_void) -> HRESULT;
}

#[cfg(target_os = "windows")]
fn parse_shell_item_id_list(path: &Path, purpose: &str) -> Result<*mut ITEMIDLIST, String> {
    unsafe {
        let mut item_id_list = std::ptr::null_mut();
        log::trace!(
            "Preparing Shell item ID list for {purpose}: {}",
            path_string(path)
        );
        SHParseDisplayName(
            &HSTRING::from(path_string(path)),
            None::<&IBindCtx>,
            &mut item_id_list,
            0,
            None,
        )
        .map_err(|error| format!("Unable to prepare the dragged file: {error}"))?;
        if item_id_list.is_null() {
            return Err("Unable to prepare the dragged file.".to_string());
        }
        log::trace!(
            "Prepared Shell item ID list for {purpose}: {}",
            path_string(path)
        );
        Ok(item_id_list)
    }
}

#[cfg(target_os = "windows")]
fn create_shell_file_data_object(paths: &[PathBuf], purpose: &str) -> Result<IDataObject, String> {
    unsafe {
        let mut item_id_lists = Vec::with_capacity(paths.len());
        let result = (|| {
            for path in paths {
                item_id_lists.push(parse_shell_item_id_list(path, purpose)?);
            }
            let raw_item_id_lists = item_id_lists
                .iter()
                .map(|item_id_list| *item_id_list as *const ITEMIDLIST)
                .collect::<Vec<_>>();
            log::debug!(
                "Creating Shell item array for {purpose}: files={}",
                raw_item_id_lists.len()
            );
            let shell_items = SHCreateShellItemArrayFromIDLists(&raw_item_id_lists)
                .map_err(|error| format!("Unable to prepare the selected files: {error}"))?;
            let data_object: IDataObject = shell_items
                .BindToHandler(None::<&IBindCtx>, &BHID_DataObject)
                .map_err(|error| format!("Unable to create the Shell file data object: {error}"))?;
            log::debug!("Shell IDataObject created for {purpose}");
            Ok(data_object)
        })();
        for item_id_list in item_id_lists {
            CoTaskMemFree(Some(item_id_list.cast()));
        }
        result
    }
}

#[cfg(target_os = "windows")]
fn create_sh_file_data_object(paths: &[PathBuf]) -> Result<IDataObject, String> {
    let first_path = paths
        .first()
        .ok_or_else(|| "Select at least one file for the Shell data object.".to_string())?;
    let parent = first_path
        .parent()
        .ok_or_else(|| "Unable to resolve the selected file's parent folder.".to_string())?;
    let parent_key = path_string(parent).to_ascii_lowercase();
    if paths.iter().any(|path| {
        path.parent()
            .map(|candidate| path_string(candidate).to_ascii_lowercase())
            .as_deref()
            != Some(parent_key.as_str())
    }) {
        return Err(
            "SHCreateDataObject requires all selected files to share one parent folder."
                .to_string(),
        );
    }

    unsafe {
        let pidl_started_at = Instant::now();
        let parent_id_list = parse_shell_item_id_list(parent, "SHCreateDataObject parent")?;
        let mut absolute_item_id_lists = Vec::with_capacity(paths.len());
        let result = (|| {
            let mut child_item_id_lists = Vec::with_capacity(paths.len());
            for path in paths {
                let absolute = parse_shell_item_id_list(path, "SHCreateDataObject child")?;
                absolute_item_id_lists.push(absolute);
                let mut child = std::ptr::null_mut();
                let _parent_folder: IShellFolder = SHBindToParent(absolute, Some(&mut child))
                    .map_err(|error| {
                        format!(
                            "Unable to resolve a relative child PIDL for {}: {error}",
                            path_string(path)
                        )
                    })?;
                if child.is_null() {
                    return Err(format!(
                        "The relative child PIDL is empty for {}.",
                        path_string(path)
                    ));
                }
                child_item_id_lists.push(child as *const ITEMIDLIST);
            }
            let pidl_elapsed = pidl_started_at.elapsed();
            log::debug!(
                "Creating Shell file data object with SHCreateDataObject: parent={}, files={}",
                path_string(parent),
                child_item_id_lists.len()
            );
            let creation_started_at = Instant::now();
            let data_object = SHCreateDataObject::<_, IDataObject>(
                Some(parent_id_list),
                Some(&child_item_id_lists),
                None::<&IDataObject>,
            )
            .map_err(|error| format!("SHCreateDataObject failed: {error}"))?;
            log::debug!(
                "Shell file data object created: files={}, pidl_ms={}, sh_create_data_object_ms={}, total_ms={}",
                child_item_id_lists.len(),
                pidl_elapsed.as_millis(),
                creation_started_at.elapsed().as_millis(),
                pidl_started_at.elapsed().as_millis()
            );
            Ok(data_object)
        })();
        for item_id_list in absolute_item_id_lists {
            CoTaskMemFree(Some(item_id_list.cast()));
        }
        CoTaskMemFree(Some(parent_id_list.cast()));
        result
    }
}

#[cfg(target_os = "windows")]
unsafe fn clipboard_global_memory_from_bytes(bytes: &[u8]) -> Result<HGLOBAL, String> {
    let memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len())
        .map_err(|error| format!("Unable to allocate clipboard memory: {error}"))?;
    let target = GlobalLock(memory);
    if target.is_null() {
        let _ = GlobalFree(Some(memory));
        return Err("Unable to lock clipboard memory.".to_string());
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), target.cast::<u8>(), bytes.len());
    let _ = GlobalUnlock(memory);
    Ok(memory)
}

#[cfg(target_os = "windows")]
unsafe fn set_data_object_drop_effect(
    data_object: &IDataObject,
    format_name: &str,
    drop_effect: u32,
) -> Result<(), String> {
    let format_id = registered_clipboard_format(format_name);
    if format_id == 0 {
        return Err(format!(
            "Unable to register the {format_name} clipboard format."
        ));
    }
    let effect_memory = clipboard_global_memory_from_bytes(&drop_effect.to_le_bytes())?;
    let format = FORMATETC {
        cfFormat: format_id as u16,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    let medium = STGMEDIUM {
        tymed: TYMED_HGLOBAL.0 as u32,
        u: STGMEDIUM_0 {
            hGlobal: effect_memory,
        },
        pUnkForRelease: std::mem::ManuallyDrop::new(None),
    };
    if let Err(error) = data_object.SetData(&format, &medium, true) {
        let _ = GlobalFree(Some(effect_memory));
        return Err(format!(
            "Unable to write {format_name} to the clipboard data object: {error}"
        ));
    }
    log::debug!(
        "Shell clipboard completion format written: name={format_name}, format={format_id}, effect=0x{drop_effect:X}"
    );
    Ok(())
}

#[cfg(target_os = "windows")]
pub(super) fn report_windows_clipboard_paste(
    expected_sequence: u32,
    operation: FileTaskOperation,
) -> Result<bool, String> {
    unsafe {
        let current_sequence = GetClipboardSequenceNumber();
        if current_sequence != expected_sequence {
            log::info!(
                "Shell clipboard paste completion skipped because the clipboard changed: expected_sequence={expected_sequence}, current_sequence={current_sequence}, operation={operation:?}"
            );
            return Ok(false);
        }
        let data_object = OleGetClipboard().map_err(|error| {
            format!("Unable to access the Shell clipboard data object after paste: {error}")
        })?;
        let effect = match operation {
            FileTaskOperation::Copy => DROPEFFECT_COPY.0,
            FileTaskOperation::Move => DROPEFFECT_MOVE.0,
        };
        set_data_object_drop_effect(&data_object, "Performed DropEffect", effect)?;
        set_data_object_drop_effect(&data_object, "Logical Performed DropEffect", effect)?;
        if operation == FileTaskOperation::Move {
            set_data_object_drop_effect(&data_object, "Paste Succeeded", effect)?;
        }
        log::info!(
            "Shell clipboard paste completion reported: sequence={current_sequence}, operation={operation:?}, effect=0x{effect:X}"
        );
        Ok(true)
    }
}

#[cfg(not(target_os = "windows"))]
pub(super) fn report_windows_clipboard_paste(
    _expected_sequence: u32,
    _operation: FileTaskOperation,
) -> Result<bool, String> {
    Err("Shell clipboard paste reporting is currently available only on Windows.".to_string())
}

#[cfg(target_os = "windows")]
unsafe fn registered_clipboard_format(name: &str) -> u32 {
    let name = HSTRING::from(name);
    RegisterClipboardFormatW(PCWSTR(name.as_ptr()))
}

#[cfg(target_os = "windows")]
unsafe fn clipboard_format_label(format: u16) -> String {
    if format == CF_HDROP.0 {
        return "CF_HDROP".to_string();
    }
    const REGISTERED_NAMES: [&str; 12] = [
        "Shell IDList Array",
        "Preferred DropEffect",
        "DataObjectAttributes",
        "DataObjectAttributesRequiringElevation",
        "DropDescription",
        "UIDisplayed",
        "Shell Object Offsets",
        "AsyncFlag",
        "FileName",
        "FileContents",
        "FileNameW",
        "FileGroupDescriptorW",
    ];
    REGISTERED_NAMES
        .iter()
        .find(|name| registered_clipboard_format(name) == format as u32)
        .map(|name| (*name).to_string())
        .unwrap_or_else(|| format!("format-{format}"))
}

#[cfg(target_os = "windows")]
unsafe fn log_data_object_diagnostics(stage: &str, data_object: &IDataObject) {
    let mut format_count = 0_u32;
    match data_object.EnumFormatEtc(DATADIR_GET.0 as u32) {
        Ok(enumerator) => loop {
            let mut item = [FORMATETC::default()];
            let mut fetched = 0_u32;
            let status = enumerator.Next(&mut item, Some(&mut fetched));
            if status != S_OK || fetched == 0 {
                break;
            }
            let format = item[0];
            format_count += 1;
            log::trace!(
                "Clipboard IDataObject format: stage={stage}, index={format_count}, id={}, name={}, tymed=0x{:X}, aspect=0x{:X}, lindex={}, target_device={}",
                format.cfFormat,
                clipboard_format_label(format.cfFormat),
                format.tymed,
                format.dwAspect,
                format.lindex,
                if format.ptd.is_null() { "null" } else { "present" }
            );
            if !format.ptd.is_null() {
                CoTaskMemFree(Some(format.ptd.cast()));
            }
        },
        Err(error) => {
            log::warn!("Clipboard IDataObject enumeration failed: stage={stage}, error={error}")
        }
    }
    log::trace!(
        "Clipboard IDataObject enumeration completed: stage={stage}, formats={format_count}"
    );

    const CORE_FORMATS: [&str; 4] = [
        "CF_HDROP",
        "Shell IDList Array",
        "Preferred DropEffect",
        "DataObjectAttributes",
    ];
    for name in CORE_FORMATS {
        let format_id = if name == "CF_HDROP" {
            CF_HDROP.0 as u32
        } else {
            registered_clipboard_format(name)
        };
        if format_id == 0 {
            log::warn!("Clipboard core format registration failed: stage={stage}, name={name}");
            continue;
        }
        let query = FORMATETC {
            cfFormat: format_id as u16,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };
        let status = data_object.QueryGetData(&query);
        log::trace!(
            "Clipboard IDataObject QueryGetData: stage={stage}, id={format_id}, name={name}, available={}, hresult=0x{:08X}",
            status == S_OK,
            status.0 as u32
        );
    }
}

#[cfg(target_os = "windows")]
pub(super) fn write_windows_file_clipboard(
    paths: &[PathBuf],
    drop_effect: u32,
    requested_owner: Option<isize>,
) -> Result<(), String> {
    unsafe {
        let started_at = Instant::now();
        log::debug!(
            "Creating Explorer-compatible OLE clipboard data object with SHCreateDataObject: files={}, requested_owner=0x{:X}",
            paths.len(),
            requested_owner.unwrap_or_default()
        );
        let data_object_started_at = Instant::now();
        let data_object = create_sh_file_data_object(paths)?;
        let data_object_elapsed = data_object_started_at.elapsed();

        let effect_started_at = Instant::now();
        let format_name = HSTRING::from("Preferred DropEffect");
        let preferred_effect_format = RegisterClipboardFormatW(PCWSTR(format_name.as_ptr()));
        if preferred_effect_format == 0 {
            return Err(
                "Unable to register the Preferred DropEffect clipboard format.".to_string(),
            );
        }
        let effect_bytes = drop_effect.to_le_bytes();
        let effect_memory = clipboard_global_memory_from_bytes(&effect_bytes)?;
        let format = FORMATETC {
            cfFormat: preferred_effect_format as u16,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };
        let medium = STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 {
                hGlobal: effect_memory,
            },
            pUnkForRelease: std::mem::ManuallyDrop::new(None),
        };
        if let Err(error) = data_object.SetData(&format, &medium, true) {
            let _ = GlobalFree(Some(effect_memory));
            return Err(format!(
                "Unable to attach the clipboard copy/cut effect to the Shell data object: {error}"
            ));
        }
        log::debug!(
            "SHCreateDataObject IDataObject Preferred DropEffect attached: format={preferred_effect_format}, value=0x{drop_effect:X}"
        );
        let effect_elapsed = effect_started_at.elapsed();
        let diagnostics_started_at = Instant::now();
        let diagnostics_enabled = log::log_enabled!(log::Level::Trace);
        if diagnostics_enabled {
            log_data_object_diagnostics("source-before-publish", &data_object);
        }
        let diagnostics_elapsed = diagnostics_started_at.elapsed();

        let sequence_before = GetClipboardSequenceNumber();
        let set_started_at = Instant::now();
        OleSetClipboard(&data_object)
            .map_err(|error| format!("Unable to publish the Shell file clipboard: {error}"))?;
        let set_elapsed = set_started_at.elapsed();
        LIVE_FILE_CLIPBOARD_OBJECT.with(|slot| {
            slot.replace(Some(data_object));
        });
        log::debug!(
            "Live OLE clipboard object published and retained on the STA thread: sequence_before={sequence_before}, sequence_after={}, data_object_ms={}, preferred_effect_ms={}, diagnostics_enabled={diagnostics_enabled}, diagnostics_ms={}, publish_ms={}, total_ms={}, immediate_flush=false",
            GetClipboardSequenceNumber(),
            data_object_elapsed.as_millis(),
            effect_elapsed.as_millis(),
            diagnostics_elapsed.as_millis(),
            set_elapsed.as_millis(),
            started_at.elapsed().as_millis()
        );
        Ok(())
    }
}

#[cfg(target_os = "windows")]
pub(super) fn flush_windows_file_clipboard() -> Result<(), String> {
    LIVE_FILE_CLIPBOARD_OBJECT.with(|slot| {
        let mut slot = slot.borrow_mut();
        let Some(data_object) = slot.as_ref() else {
            log::debug!("No live Explorer file clipboard object requires shutdown handoff");
            return Ok(());
        };

        let ownership = unsafe { ole_is_current_clipboard(data_object.as_raw()) };
        if ownership == S_FALSE {
            slot.take();
            log::debug!(
                "Explorer file clipboard was replaced before shutdown; released the stale data object"
            );
            return Ok(());
        }
        if ownership != S_OK {
            return Err(format!(
                "Unable to verify the Explorer file clipboard owner: {}",
                windows::core::Error::from_hresult(ownership)
            ));
        }

        unsafe {
            OleFlushClipboard()
                .map_err(|error| format!("Unable to flush the Explorer file clipboard: {error}"))?;
        }
        slot.take();
        log::info!("Explorer file clipboard was materialized for application shutdown");
        Ok(())
    })
}

#[cfg(not(target_os = "windows"))]
pub(super) fn flush_windows_file_clipboard() -> Result<(), String> {
    Ok(())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn shutdown_flush_is_a_noop_without_a_live_clipboard_object() {
        assert!(flush_windows_file_clipboard().is_ok());
    }
}

#[cfg(target_os = "windows")]
pub(super) fn reveal_windows_path(path: &Path) -> Result<(), String> {
    let path = path.to_path_buf();
    thread::spawn(move || unsafe {
        OleInitialize(None).map_err(|error| {
            format!("Unable to initialize the Explorer reveal operation: {error}")
        })?;
        let result = (|| {
            let item_id_list = parse_shell_item_id_list(&path, "Explorer reveal")?;
            log::debug!(
                "Opening Explorer with selected item via SHOpenFolderAndSelectItems: {}",
                path_string(&path)
            );
            let open_result = SHOpenFolderAndSelectItems(item_id_list, None, 0)
                .map_err(|error| format!("Unable to show the selected item in Explorer: {error}"));
            CoTaskMemFree(Some(item_id_list.cast()));
            open_result
        })();
        OleUninitialize();
        result
    })
    .join()
    .map_err(|_| "The Explorer reveal worker stopped unexpectedly.".to_string())?
}

#[cfg(not(target_os = "windows"))]
pub(super) fn reveal_windows_path(_path: &Path) -> Result<(), String> {
    Err("Showing a selected item in the system file manager is currently available only on Windows."
        .to_string())
}

#[cfg(target_os = "windows")]
pub(super) fn start_windows_file_drag(paths: Vec<PathBuf>) -> Result<(), String> {
    unsafe {
        log::debug!("Initializing OLE file drag for {} file(s)", paths.len());
        OleInitialize(None)
            .map_err(|error| format!("Unable to initialize Windows drag-and-drop: {error}"))?;
        log::debug!("OLE initialization succeeded for file drag");
        let result = (|| {
            let data_object = create_shell_file_data_object(&paths, "file drag")?;
            log::debug!("File-drag IDataObject created; entering DoDragDrop with COPY effect");
            let drag_source: IDropSource = WindowsFileDragSource::new().into();
            let mut effect = DROPEFFECT(0);
            DoDragDrop(&data_object, &drag_source, DROPEFFECT_COPY, &mut effect)
                .ok()
                .map_err(|error| format!("Windows drag-and-drop failed: {error}"))?;
            log::debug!(
                "DoDragDrop returned successfully with effect 0x{:X}",
                effect.0
            );
            Ok(())
        })();
        OleUninitialize();
        match &result {
            Ok(()) => log::debug!("OLE file drag session finished successfully"),
            Err(error) => log::warn!("OLE file drag session failed: {error}"),
        }
        result
    }
}

#[cfg(not(target_os = "windows"))]
pub(super) fn start_windows_file_drag(_paths: Vec<PathBuf>) -> Result<(), String> {
    Err(
        "Dragging files to the system file manager is currently available only on Windows."
            .to_string(),
    )
}
