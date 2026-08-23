; CallerFlash custom NSIS installer hooks.
; Referenced from tauri.conf.json (bundle > windows > nsis > installerHooks).
;
; PREUNINSTALL runs before files are deleted, but registry values are
; independent of the install directory — the point is to remove the autorun
; entries created by app_set_start_with_windows (src-tauri/src/lib.rs) so an
; uninstalled app does not leave a launch-at-signin entry pointing at a
; deleted executable. Both keys are shared by other applications, so we only
; delete our own value, never the key itself.

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Removing CallerFlash autorun entries…"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CallerFlash"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "CallerFlash"
!macroend
