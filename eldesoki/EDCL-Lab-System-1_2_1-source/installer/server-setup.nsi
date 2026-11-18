; EDCL-Server-Setup.exe - built with NSIS (cross-compiled on Linux). NOT executed on Windows by the builder: see docs/TEST_REPORT_deployment.md
; Silent: EDCL-Server-Setup.exe /S /NAME=edcl-server /IP=192.168.1.20 /PORT=8443 /DATA=D:\EDCL\data /BACKUP=E:\EDCL-backups /OWNER=admin
Unicode true
!include MUI2.nsh
!include nsDialogs.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!ifndef VERSION
  !define VERSION "1.2.0"
!endif
Name "EDCL Central Server ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\EDCL Server"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
BrandingText "EDCL Laboratory Management System - Central Server ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "EDCL Central Server"
VIAddVersionKey "CompanyName" "Egyptian Doping Control Laboratory"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "EDCL central server installer"
!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom CfgPage CfgLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Var D
Var hName
Var hIp
Var hPort
Var hData
Var hBackup
Var hOwner
Var vName
Var vIp
Var vPort
Var vData
Var vBackup
Var vOwner
Var vOut

; command-line value reader: ${GetOptions} mangles values (cuts at "//", loses backslashes), so read "/NAME=value" ourselves (value may be "quoted")
Function SrvArg
  Exch $R1
  Push $R2
  Push $R3
  Push $R4
  StrLen $R2 $R1
  StrCpy $R3 0
  srvarg_scan:
    StrCpy $R4 $CMDLINE $R2 $R3
    StrCmp $R4 "" srvarg_none
    StrCmp $R4 $R1 srvarg_found
    IntOp $R3 $R3 + 1
    Goto srvarg_scan
  srvarg_found:
    IntOp $R3 $R3 + $R2
    StrCpy $R4 $CMDLINE 1 $R3
    StrCmp $R4 '"' 0 srvarg_plain
    IntOp $R3 $R3 + 1
    StrCpy $R1 ""
    srvarg_q:
      StrCpy $R4 $CMDLINE 1 $R3
      StrCmp $R4 "" srvarg_done
      StrCmp $R4 '"' srvarg_done
      StrCpy $R1 "$R1$R4"
      IntOp $R3 $R3 + 1
      Goto srvarg_q
  srvarg_plain:
    StrCpy $R1 ""
    srvarg_p:
      StrCpy $R4 $CMDLINE 1 $R3
      StrCmp $R4 "" srvarg_done
      StrCmp $R4 " " srvarg_done
      StrCmp $R4 '"' srvarg_done
      StrCpy $R1 "$R1$R4"
      IntOp $R3 $R3 + 1
      Goto srvarg_p
  srvarg_none:
    StrCpy $R1 ""
  srvarg_done:
  Pop $R4
  Pop $R3
  Pop $R2
  Exch $R1
FunctionEnd

Function .onInit
  Push "/NAME="
  Call SrvArg
  Pop $vName
  Push "/IP="
  Call SrvArg
  Pop $vIp
  Push "/PORT="
  Call SrvArg
  Pop $vPort
  Push "/DATA="
  Call SrvArg
  Pop $vData
  Push "/BACKUP="
  Call SrvArg
  Pop $vBackup
  Push "/OWNER="
  Call SrvArg
  Pop $vOwner
  ReadEnvStr $0 "ProgramData"
  ${If} $vPort == ""
    StrCpy $vPort "8443"
  ${EndIf}
  ${If} $vData == ""
    StrCpy $vData "$0\EDCL Server\data"
  ${EndIf}
  ${If} $vBackup == ""
    StrCpy $vBackup "$0\EDCL Server\backups"
  ${EndIf}
  ${If} $vOwner == ""
    StrCpy $vOwner "admin"
  ${EndIf}
  ${If} $vName == ""
    ReadEnvStr $vName "COMPUTERNAME"
  ${EndIf}
FunctionEnd

Function CfgPage
  !insertmacro MUI_HEADER_TEXT "Server settings" "These values go into the HTTPS certificate and the server configuration."
  nsDialogs::Create 1018
  Pop $D
  ${NSD_CreateLabel} 0 0 100% 20u "Server name(s) that workstations will use (comma separated, e.g. edcl-server). Do not rely on a temporary IP address as the only address."
  Pop $0
  ${NSD_CreateText} 0 22u 100% 12u $vName
  Pop $hName
  ${NSD_CreateLabel} 0 38u 60% 10u "Fixed IPv4 address(es) of this PC (comma separated, optional):"
  Pop $0
  ${NSD_CreateText} 0 49u 60% 12u $vIp
  Pop $hIp
  ${NSD_CreateLabel} 65% 38u 35% 10u "Port:"
  Pop $0
  ${NSD_CreateText} 65% 49u 20% 12u $vPort
  Pop $hPort
  ${NSD_CreateLabel} 0 65u 100% 10u "Database folder (local disk with free space):"
  Pop $0
  ${NSD_CreateText} 0 76u 100% 12u $vData
  Pop $hData
  ${NSD_CreateLabel} 0 92u 100% 10u "Backup folder (ideally a SECOND disk or a network share the server account can write to):"
  Pop $0
  ${NSD_CreateText} 0 103u 100% 12u $vBackup
  Pop $hBackup
  ${NSD_CreateLabel} 0 119u 60% 10u "First administrator user name:"
  Pop $0
  ${NSD_CreateText} 0 130u 40% 12u $vOwner
  Pop $hOwner
  nsDialogs::Show
FunctionEnd

Function CfgLeave
  ${NSD_GetText} $hName $vName
  ${NSD_GetText} $hIp $vIp
  ${NSD_GetText} $hPort $vPort
  ${NSD_GetText} $hData $vData
  ${NSD_GetText} $hBackup $vBackup
  ${NSD_GetText} $hOwner $vOwner
  ${If} $vName == ""
  ${AndIf} $vIp == ""
    MessageBox MB_ICONSTOP "Enter at least one server name or IP address."
    Abort
  ${EndIf}
FunctionEnd

Section "Server"
  SetOutPath "$INSTDIR"
  ReadEnvStr $0 "ProgramData"
  CreateDirectory "$0\EDCL Server"
  ; stop an older server first (data is untouched)
  FileOpen $1 "$0\EDCL Server\stop.flag" w
  ${If} $1 != ""
    FileClose $1
  ${EndIf}
  nsExec::Exec 'schtasks /End /TN "EDCL Server"'
  Sleep 2000
  File "${STAGE}\node.exe"
  File "${STAGE}\run-server.cmd"
  File "${STAGE}\edcl-server-ctl.cmd"
  File "${STAGE}\wada-monitor.js"
  File "${STAGE}\package.json"
  File "${STAGE}\LICENSE-node.txt"
  File /r "${STAGE}\server"
  File /r "${STAGE}\node_modules"
  CreateDirectory "$vData"
  CreateDirectory "$vBackup"
  ; certificates, config, first administrator (the one-time password is printed once)
  nsExec::ExecToStack '"$INSTDIR\node.exe" --no-warnings "$INSTDIR\server\setup-helper.js" --name "$vName" --ip "$vIp" --port "$vPort" --data "$vData" --backup "$vBackup" --root "$0\EDCL Server" --owner "$vOwner"'
  Pop $2
  Pop $vOut
  DetailPrint "$vOut"
  ${If} $2 != 0
    ${If} ${Silent}
      FileOpen $8 "$TEMP\edcl-server-setup-error.log" w
      FileWrite $8 "Server setup failed (code $2): $vOut$\r$\n"
      FileClose $8
      SetErrorLevel 3
      Abort
    ${EndIf}
    MessageBox MB_ICONSTOP "Server setup failed:$\r$\n$vOut"
    Abort
  ${EndIf}
  ; only administrators/SYSTEM may read data, keys and backups
  nsExec::Exec 'icacls "$0\EDCL Server\certs" /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F"'
  nsExec::Exec 'icacls "$vData" /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F"'
  nsExec::Exec 'icacls "$vBackup" /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F"'
  ; firewall (private + domain networks only) and start at boot
  nsExec::Exec 'netsh advfirewall firewall delete rule name="EDCL Server"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="EDCL Server" dir=in action=allow protocol=TCP localport=$vPort profile=private,domain'
  nsExec::Exec 'schtasks /Delete /TN "EDCL Server" /F'
  nsExec::Exec 'schtasks /Create /TN "EDCL Server" /TR "\"$INSTDIR\run-server.cmd\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F'
  nsExec::Exec 'schtasks /Run /TN "EDCL Server"'
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\EDCLServer" "DisplayName" "EDCL Central Server"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\EDCLServer" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\EDCLServer" "UninstallString" "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\EDCL Server"
  CreateShortcut "$SMPROGRAMS\EDCL Server\Server folder (client-config, logs).lnk" "explorer.exe" '"$0\EDCL Server"'
  CreateShortcut "$SMPROGRAMS\EDCL Server\Server control prompt.lnk" "cmd.exe" '/k cd /d "$INSTDIR" && edcl-server-ctl.cmd'
  ${IfNot} ${Silent}
    MessageBox MB_ICONINFORMATION "Server installed and started.$\r$\n$\r$\nWRITE DOWN the administrator name and ONE-TIME PASSWORD from the details (field ownerPassword). It is shown only now. If the field is empty an administrator already existed.$\r$\n$\r$\nNext: copy the folder  $0\EDCL Server\client-config  to every workstation, next to EDCL-Client-Setup.exe."
    ExecShell "open" "$0\EDCL Server\client-config"
  ${EndIf}
SectionEnd

Section "Uninstall"
  ReadEnvStr $0 "ProgramData"
  FileOpen $1 "$0\EDCL Server\stop.flag" w
  ${If} $1 != ""
    FileClose $1
  ${EndIf}
  nsExec::Exec 'schtasks /End /TN "EDCL Server"'
  nsExec::Exec 'schtasks /Delete /TN "EDCL Server" /F'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="EDCL Server"'
  Sleep 1500
  RMDir /r "$INSTDIR"
  RMDir /r "$SMPROGRAMS\EDCL Server"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\EDCLServer"
  MessageBox MB_ICONINFORMATION "The server program was removed.$\r$\nThe DATABASE, BACKUPS and CERTIFICATES in $0\EDCL Server (and the folders you chose) were NOT deleted. Delete them yourself only when you are sure."
SectionEnd
