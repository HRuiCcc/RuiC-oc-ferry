; Installed once, resident afterwards: the autostart entry launches the tray-only
; mode (--hidden), so the models imported into WorkBuddy stay reachable without
; the user re-opening anything. The uninstaller removes exactly this one value.

!macro customInstall
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OC Ferry" '"$INSTDIR\OC Ferry.exe" --hidden'
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OC Ferry"
!macroend
