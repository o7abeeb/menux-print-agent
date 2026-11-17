; Menux Print Agent - custom NSIS steps (electron-builder includes this file).
;
; Replaces electron-builder's default "is the app running?" check. The default
; one only kills a copy owned by the current user and, if that copy survives
; (it was started "as administrator", e.g. by an installer that ran elevated),
; it stops with "Menux Print Agent cannot be closed. Please close it manually"
; - a tray app the restaurant can't easily find, so the install just fails.
;
; Here: close every running copy (graceful, then forced, whole process tree),
; and if one still survives, kill it with admin rights (one UAC prompt).

!macro customCheckAppRunning
  DetailPrint `Closing running "${PRODUCT_NAME}"...`
  nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /t /im "${APP_EXECUTABLE_FILENAME}"`
  Pop $R0
  Sleep 800
  nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}"`
  Pop $R0
  Sleep 800

  nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO csv | %SYSTEMROOT%\System32\find.exe /I "${APP_EXECUTABLE_FILENAME}"`
  Pop $R0
  ${if} $R0 == 0
    ; Still running = started with admin rights: kill it elevated.
    ExecShellWait "runas" "$WINDIR\System32\taskkill.exe" `/f /t /im "${APP_EXECUTABLE_FILENAME}"` SW_HIDE
    Sleep 1500
  ${endIf}
!macroend
