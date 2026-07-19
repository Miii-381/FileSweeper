; VideoSweeper stores mutable data beside the executable instead of in the
; Tauri default AppData locations. The generated NSIS template does not know
; about this directory, so remove it explicitly only for a real uninstall.
;
; The pre-uninstall hook runs after the confirmation page but before registry
; cleanup. It repeats the generated process check so a failed data deletion
; can abort safely without unregistering a still-installed application.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  ${If} $UpdateMode <> 1
    DetailPrint "Removing VideoSweeper data directory"
    ClearErrors
    RMDir /r "$INSTDIR\data"
    ${If} ${Errors}
      MessageBox MB_ICONEXCLAMATION "VideoSweeper data could not be removed. Close programs using the data directory and run the uninstaller again."
      Abort
    ${EndIf}
  ${EndIf}
!macroend
