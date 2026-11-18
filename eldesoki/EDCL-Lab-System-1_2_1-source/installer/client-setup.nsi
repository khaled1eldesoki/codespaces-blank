; EDCL-Client-Setup.exe - installs the EDCL Lab System workstation application and its server connection.
; Silent install: EDCL-Client-Setup.exe /S /SERVER=https://edcl-server:8443 /CA=C:\path\ca.crt [/TRUSTWIN=1] [/D=C:\Program Files\EDCL Lab System]
; Data safety: the installer NEVER touches %APPDATA%\EDCL Lab System (user data, WADA history, backups settings), so updates keep all data.
Unicode true
!include MUI2.nsh
!include nsDialogs.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!ifndef VERSION
  !define VERSION "1.2.0"
!endif
Name "EDCL Lab System ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\EDCL Lab System"
InstallDirRegKey HKLM "Software\EDCL Lab System" "InstallDir"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
BrandingText "EDCL Laboratory Management System ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "EDCL Lab System"
VIAddVersionKey "CompanyName" "Egyptian Doping Control Laboratory"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "EDCL Lab System workstation installer"
!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom SrvPage SrvLeave
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\EDCL Lab System.exe"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Var D
Var hUrl
Var hCa
Var hTrust
Var vUrl
Var vCa
Var vTrust
Var vFp

Function .onInit
  ${GetOptions} $CMDLINE "/SERVER=" $vUrl
  ${GetOptions} $CMDLINE "/CA=" $vCa
  ${GetOptions} $CMDLINE "/TRUSTWIN=" $vTrust
  ; auto-fill from a client-config folder placed next to this installer
  ${If} $vUrl == ""
  ${AndIf} ${FileExists} "$EXEDIR\client-config\server-url.txt"
    FileOpen $0 "$EXEDIR\client-config\server-url.txt" r
    FileRead $0 $vUrl
    FileClose $0
  ${EndIf}
  ${If} $vCa == ""
  ${AndIf} ${FileExists} "$EXEDIR\client-config\ca.crt"
    StrCpy $vCa "$EXEDIR\client-config\ca.crt"
  ${EndIf}
FunctionEnd

Function SrvPage
  !insertmacro MUI_HEADER_TEXT "Server connection" "Address of the EDCL central server and the laboratory certificate."
  nsDialogs::Create 1018
  Pop $D
  ${NSD_CreateLabel} 0 0 100% 20u "Server address (from the server installer), for example  https://edcl-server:8443  - use the NAME, not a temporary IP."
  Pop $0
  ${NSD_CreateText} 0 24u 100% 12u $vUrl
  Pop $hUrl
  ${NSD_CreateLabel} 0 44u 100% 10u "Laboratory certificate file (ca.crt from the server's client-config folder):"
  Pop $0
  ${NSD_CreateText} 0 56u 80% 12u $vCa
  Pop $hCa
  ${NSD_CreateBrowseButton} 82% 55u 18% 14u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 BrowseCa
  ${NSD_CreateCheckbox} 0 80u 100% 20u "Also trust the laboratory certificate in Windows (only needed to open the phone viewer page in a web browser on this PC; the EDCL application does not need it)"
  Pop $hTrust
  ${If} $vTrust == "1"
    ${NSD_Check} $hTrust
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function BrowseCa
  nsDialogs::SelectFileDialog open "" "Certificate|*.crt;*.cer;*.pem"
  Pop $0
  ${If} $0 != ""
    ${NSD_SetText} $hCa $0
  ${EndIf}
FunctionEnd

Function SrvLeave
  ${NSD_GetText} $hUrl $vUrl
  ${NSD_GetText} $hCa $vCa
  ${NSD_GetState} $hTrust $vTrust
  ${If} $vTrust == ${BST_CHECKED}
    StrCpy $vTrust "1"
  ${EndIf}
  Call ValidateInputs
FunctionEnd

Function ValidateInputs
  StrCpy $0 $vUrl 8
  ${If} $0 != "https://"
    MessageBox MB_ICONSTOP "The server address must start with https://"
    Abort
  ${EndIf}
  ${IfNot} ${FileExists} "$vCa"
    MessageBox MB_ICONSTOP "Certificate file not found: $vCa"
    Abort
  ${EndIf}
  ; show the fingerprint so it can be compared with the one printed by the server installer
  nsExec::ExecToStack 'powershell -NoProfile -Command "(New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 \"$vCa\").GetCertHashString(\"SHA256\")"'
  Pop $0
  Pop $vFp
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "This file is not a valid certificate."
    Abort
  ${EndIf}
  ${IfNot} ${Silent}
    MessageBox MB_ICONQUESTION|MB_YESNO "Certificate fingerprint (SHA-256):$\r$\n$\r$\n$vFp$\r$\n$\r$\nDoes it match the fingerprint in the server's client-config\README.txt (ignore the colons)?" IDYES ok
    Abort
    ok:
  ${EndIf}
FunctionEnd

Section "EDCL Lab System"
  ${If} $vUrl != ""
    Call ValidateInputs
  ${EndIf}
  SetOutPath "$INSTDIR"
  nsExec::Exec 'taskkill /F /IM "EDCL Lab System.exe"'
  Sleep 1000
  File /r "${STAGE}\*.*"
  ; server connection (machine wide, not in the user's data folder)
  ReadEnvStr $1 "ProgramData"
  CreateDirectory "$1\EDCL Lab System\client"
  CopyFiles /SILENT "$vCa" "$1\EDCL Lab System\client\ca.crt"
  FileOpen $2 "$1\EDCL Lab System\client\server.json" w
  FileWrite $2 '{"serverUrl":"$vUrl"}'
  FileClose $2
  ${If} $vTrust == "1"
    nsExec::Exec 'certutil -addstore -f Root "$1\EDCL Lab System\client\ca.crt"'
  ${EndIf}
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\EDCL Lab System" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\EDCLLabSystem" "DisplayName" "EDCL Lab System"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\EDCLLabSystem" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\EDCLLabSystem" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\EDCLLabSystem" "DisplayIcon" "$INSTDIR\icon.ico"
  CreateDirectory "$SMPROGRAMS\EDCL Lab System"
  CreateShortcut "$SMPROGRAMS\EDCL Lab System\EDCL Lab System.lnk" "$INSTDIR\EDCL Lab System.exe" "" "$INSTDIR\icon.ico"
  CreateShortcut "$DESKTOP\EDCL Lab System.lnk" "$INSTDIR\EDCL Lab System.exe" "" "$INSTDIR\icon.ico"
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM "EDCL Lab System.exe"'
  Sleep 800
  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\EDCL Lab System.lnk"
  RMDir /r "$SMPROGRAMS\EDCL Lab System"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\EDCLLabSystem"
  DeleteRegKey HKLM "Software\EDCL Lab System"
  MessageBox MB_ICONINFORMATION "The application was removed. Your data folder (%APPDATA%\EDCL Lab System) and the server connection settings were kept."
SectionEnd
