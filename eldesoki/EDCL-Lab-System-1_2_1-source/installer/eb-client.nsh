; EDCL Lab System - electron-builder NSIS hooks (client). Same appId as the 1.0.x installer (eg.edcl.labsystem) => in-place upgrade, one app entry.
; Silent switches (besides electron-builder's /S /allusers /currentuser /D=):
;   /SERVER=https://edcl-server:8443  /CA=C:\path\ca.crt  [/TRUSTWIN=1]  [/STANDALONE=1]
; A "client-config" folder placed next to the installer (from the server PC) is picked up automatically.
; DATA SAFETY: the installer never writes into %APPDATA%\EDCL Lab System except to make ONE safety copy of it before the first upgrade.

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    !include nsDialogs.nsh
    Var D
    Var hUrl
    Var hCa
    Var hTrust
    Var hStand
    Var vUrl
    Var vCa
    Var vTrust
    Var vStand
    Var vHave
    Var vCmd

    ; ---- does a server configuration already exist on this PC? (kept untouched on upgrade) ----
    ; command-line value reader: ${GetOptions} cuts values at "//" (https://...), so read "/NAME=value" ourselves (value may be "quoted")
    Function EdclArg
      Exch $R1
      Push $R2
      Push $R3
      Push $R4
      StrLen $R2 $R1
      StrCpy $R3 0
      edclarg_scan:
        StrCpy $R4 $vCmd $R2 $R3
        StrCmp $R4 "" edclarg_none
        StrCmp $R4 $R1 edclarg_found
        IntOp $R3 $R3 + 1
        Goto edclarg_scan
      edclarg_found:
        IntOp $R3 $R3 + $R2
        StrCpy $R4 $vCmd 1 $R3
        StrCmp $R4 '"' 0 edclarg_plain
        IntOp $R3 $R3 + 1
        StrCpy $R1 ""
        edclarg_q:
          StrCpy $R4 $vCmd 1 $R3
          StrCmp $R4 "" edclarg_done
          StrCmp $R4 '"' edclarg_done
          StrCpy $R1 "$R1$R4"
          IntOp $R3 $R3 + 1
          Goto edclarg_q
      edclarg_plain:
        StrCpy $R1 ""
        edclarg_p:
          StrCpy $R4 $vCmd 1 $R3
          StrCmp $R4 "" edclarg_done
          StrCmp $R4 " " edclarg_done
          StrCmp $R4 '"' edclarg_done
          StrCpy $R1 "$R1$R4"
          IntOp $R3 $R3 + 1
          Goto edclarg_p
      edclarg_none:
        StrCpy $R1 ""
      edclarg_done:
      Pop $R4
      Pop $R3
      Pop $R2
      Exch $R1
    FunctionEnd

    Function EdclTrimUrl
      edcltrim:
      StrCpy $0 $vUrl 1 -1
      ${If} $0 == "$\r"
      ${OrIf} $0 == "$\n"
      ${OrIf} $0 == " "
        StrCpy $vUrl $vUrl -1
        Goto edcltrim
      ${EndIf}
    FunctionEnd

    Function EdclHaveConfig
      StrCpy $vHave "0"
      ReadEnvStr $1 "ProgramData"
      ${If} ${FileExists} "$1\EDCL Lab System\client\server.json"
        StrCpy $vHave "1"
      ${EndIf}
      ${If} ${FileExists} "$APPDATA\EDCL Lab System\central.json"
        StrCpy $vHave "1"
      ${EndIf}
    FunctionEnd

    Function EdclSrvPage
      ${If} $vHave == "1"
      ${AndIf} $vUrl == ""
        Abort ; existing server connection is kept as is
      ${EndIf}
      !insertmacro MUI_HEADER_TEXT "Server connection" "All workstations must use the same central EDCL server and shared database."
      nsDialogs::Create 1018
      Pop $D
      ${NSD_CreateLabel} 0 0 100% 20u "Server address from the server installer, e.g.  https://edcl-server:8443  (use the NAME, not a temporary IP)."
      Pop $0
      ${NSD_CreateText} 0 22u 100% 12u $vUrl
      Pop $hUrl
      ${NSD_CreateLabel} 0 40u 100% 10u "Laboratory certificate file (ca.crt from the server's client-config folder):"
      Pop $0
      ${NSD_CreateText} 0 52u 80% 12u $vCa
      Pop $hCa
      ${NSD_CreateBrowseButton} 82% 51u 18% 14u "Browse..."
      Pop $0
      ${NSD_OnClick} $0 EdclBrowseCa
      ${NSD_CreateCheckbox} 0 72u 100% 18u "Also trust the laboratory certificate in Windows (administrator only; only needed to open the phone viewer in a browser)"
      Pop $hTrust
      ${If} $vTrust == "1"
        ${NSD_Check} $hTrust
      ${EndIf}
      ${NSD_CreateCheckbox} 0 94u 100% 18u "Do NOT connect this PC to the server (standalone: data stays only on this PC - not recommended)"
      Pop $hStand
      ${If} $vStand == "1"
        ${NSD_Check} $hStand
      ${EndIf}
      nsDialogs::Show
    FunctionEnd

    Function EdclBrowseCa
      nsDialogs::SelectFileDialog open "" "Certificate|*.crt;*.cer;*.pem"
      Pop $0
      ${If} $0 != ""
        ${NSD_SetText} $hCa $0
      ${EndIf}
    FunctionEnd

    Function EdclSrvLeave
      ${NSD_GetText} $hUrl $vUrl
      ${NSD_GetText} $hCa $vCa
      ${NSD_GetState} $hTrust $vTrust
      ${NSD_GetState} $hStand $vStand
      ${If} $vTrust == ${BST_CHECKED}
        StrCpy $vTrust "1"
      ${Else}
        StrCpy $vTrust "0"
      ${EndIf}
      ${If} $vStand == ${BST_CHECKED}
        StrCpy $vStand "1"
        Return
      ${Else}
        StrCpy $vStand "0"
      ${EndIf}
      Call EdclValidate
    FunctionEnd

    Function EdclFail
      ; $9 = message. Interactive: show it. Silent: never block - write a log and exit with code 3.
      ${If} ${Silent}
        FileOpen $8 "$TEMP\edcl-client-setup-error.log" a
        FileWrite $8 "$9$\r$\n"
        FileClose $8
        SetErrorLevel 3
        Quit
      ${Else}
        MessageBox MB_ICONSTOP "$9"
        Abort
      ${EndIf}
    FunctionEnd

    Function EdclValidate
      StrCpy $0 $vUrl 8
      ${If} $0 != "https://"
        StrCpy $9 "The server address must start with https:// (got: [$vUrl])"
        Call EdclFail
      ${EndIf}
      ${IfNot} ${FileExists} "$vCa"
        StrCpy $9 "Certificate file not found: [$vCa]"
        Call EdclFail
      ${EndIf}
      FileOpen $2 "$vCa" r
      FileRead $2 $3
      FileClose $2
      StrCpy $4 $3 11
      ${If} $4 != "-----BEGIN "
        StrCpy $9 "This is not a PEM certificate file (ca.crt): [$vCa]"
        Call EdclFail
      ${EndIf}
      ${IfNot} ${Silent}
        nsExec::ExecToStack 'powershell -NoProfile -Command "(New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 \"$vCa\").GetCertHashString(\"SHA256\")"'
        Pop $0
        Pop $5
        ${If} $0 == "0"
          MessageBox MB_ICONQUESTION|MB_YESNO "Certificate fingerprint (SHA-256):$\r$\n$\r$\n$5$\r$\n$\r$\nDoes it match the fingerprint in the server's client-config\README.txt (ignore colons)?" IDYES edclfpok
          Abort
          edclfpok:
        ${EndIf}
      ${EndIf}
    FunctionEnd
  !endif
!macroend

!macro customInit
  ${GetParameters} $vCmd
  Push "/SERVER="
  Call EdclArg
  Pop $vUrl
  Push "/CA="
  Call EdclArg
  Pop $vCa
  Push "/TRUSTWIN="
  Call EdclArg
  Pop $vTrust
  Push "/STANDALONE="
  Call EdclArg
  Pop $vStand
  ${If} $vUrl == ""
  ${AndIf} ${FileExists} "$EXEDIR\client-config\server-url.txt"
    FileOpen $0 "$EXEDIR\client-config\server-url.txt" r
    FileRead $0 $vUrl
    FileClose $0
    Call EdclTrimUrl
  ${EndIf}
  ${If} $vCa == ""
  ${AndIf} ${FileExists} "$EXEDIR\client-config\ca.crt"
    StrCpy $vCa "$EXEDIR\client-config\ca.crt"
  ${EndIf}
  Call EdclHaveConfig
  ${If} ${Silent}
    FileOpen $8 "$TEMP\edcl-client-setup-args.log" w
    FileWrite $8 "cmd=[$vCmd] server=[$vUrl] ca=[$vCa] standalone=[$vStand] haveConfig=[$vHave]$\r$\n"
    FileClose $8
  ${EndIf}
  ; silent install on a PC without a server connection must be explicit (prevents accidental separate local databases)
  ${If} ${Silent}
  ${AndIf} $vHave == "0"
  ${AndIf} $vUrl == ""
  ${AndIf} $vStand != "1"
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${If} ${Silent}
  ${AndIf} $vUrl != ""
  ${AndIf} $vStand != "1"
    Call EdclValidate
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom EdclSrvPage EdclSrvLeave
!macroend

!macro customInstall
  ; one-time safety copy of this user's local data folder, taken at the moment of the upgrade (rollback of data); never overwritten
  ${If} ${FileExists} "$APPDATA\EDCL Lab System\*.*"
  ${AndIfNot} ${FileExists} "$APPDATA\EDCL Lab System-backup-before-${VERSION}\*.*"
    CopyFiles /SILENT "$APPDATA\EDCL Lab System\*.*" "$APPDATA\EDCL Lab System-backup-before-${VERSION}"
  ${EndIf}
  ${If} $vStand != "1"
  ${AndIf} $vUrl != ""
    ReadEnvStr $1 "ProgramData"
    ClearErrors
    CreateDirectory "$1\EDCL Lab System\client"
    CopyFiles /SILENT "$vCa" "$1\EDCL Lab System\client\ca.crt"
    FileOpen $2 "$1\EDCL Lab System\client\server.json" w
    FileWrite $2 '{"serverUrl":"$vUrl"}'
    FileClose $2
    ${If} ${Errors}
      ; machine-wide folder not writable for this user: store in the user's own settings folder instead
      ClearErrors
      CreateDirectory "$APPDATA\EDCL Lab System"
      CopyFiles /SILENT "$vCa" "$APPDATA\EDCL Lab System\ca.crt"
      FileOpen $2 "$APPDATA\EDCL Lab System\central.json" w
      FileWrite $2 '{"serverUrl":"$vUrl"}'
      FileClose $2
    ${EndIf}
    ${If} $vTrust == "1"
    ${AndIf} ${UAC_IsAdmin}
      nsExec::Exec 'certutil -addstore -f Root "$vCa"'
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ; keep user data (%APPDATA%\EDCL Lab System) and the server connection files; nothing to remove here
!macroend
