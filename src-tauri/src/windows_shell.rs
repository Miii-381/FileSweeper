use super::*;

#[cfg(target_os = "windows")]
fn parse_shell_item_id_list(path: &Path) -> Result<*mut ITEMIDLIST, String> {
    unsafe {
        let mut item_id_list = std::ptr::null_mut();
        log::debug!(
            "Preparing Shell item ID list for file drag: {}",
            path_string(path)
        );
        SHParseDisplayName(
            &HSTRING::from(path_string(path)),
            None::<&IBindCtx>,
            &mut item_id_list,
            0,
            None,
        )
        .map_err(|error| format!("Unable to prepare the dragged video: {error}"))?;
        if item_id_list.is_null() {
            return Err("Unable to prepare the dragged video.".to_string());
        }
        log::debug!(
            "Prepared Shell item ID list for file drag: {}",
            path_string(path)
        );
        Ok(item_id_list)
    }
}

#[cfg(target_os = "windows")]
pub(super) fn start_windows_file_drag(paths: Vec<PathBuf>) -> Result<(), String> {
    unsafe {
        log::debug!("Initializing OLE file drag for {} video(s)", paths.len());
        OleInitialize(None)
            .map_err(|error| format!("Unable to initialize Windows drag-and-drop: {error}"))?;
        log::debug!("OLE initialization succeeded for file drag");
        let mut item_id_lists = Vec::with_capacity(paths.len());
        let result = (|| {
            for path in &paths {
                item_id_lists.push(parse_shell_item_id_list(path)?);
            }
            let raw_item_id_lists = item_id_lists
                .iter()
                .map(|item_id_list| *item_id_list as *const ITEMIDLIST)
                .collect::<Vec<_>>();
            log::debug!(
                "Creating Shell item array for {} dragged video(s)",
                raw_item_id_lists.len()
            );
            let shell_items = SHCreateShellItemArrayFromIDLists(&raw_item_id_lists)
                .map_err(|error| format!("Unable to prepare the dragged videos: {error}"))?;
            log::debug!("Shell item array created; requesting IDataObject for file drag");
            let data_object: IDataObject = shell_items
                .BindToHandler(None::<&IBindCtx>, &BHID_DataObject)
                .map_err(|error| format!("Unable to create the drag data object: {error}"))?;
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
        for item_id_list in item_id_lists {
            CoTaskMemFree(Some(item_id_list.cast()));
        }
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
