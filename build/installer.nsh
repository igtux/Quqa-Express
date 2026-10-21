; quqa-express uninstaller: keep the user's data (the encrypted vault with
; keys, hosts and settings) unless they ask for it to be removed. Updates
; and silent uninstalls always keep it.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your quqa-express data?$\r$\n$\r$\nThis removes the encrypted vault (keys, saved passwords, hosts and trusted host keys) and settings in$\r$\n$APPDATA\quqa-express$\r$\n$\r$\nChoose No to keep them for a later install." /SD IDNO IDNO quqaKeepData
      RMDir /r "$APPDATA\quqa-express"
    quqaKeepData:
  ${endIf}
!macroend
