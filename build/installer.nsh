!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
Var CompanyNameInput
Var CompanyNameValue
!macro customPageAfterChangeDir
  Page custom CompanyNamePageCreate CompanyNamePageLeave
!macroend

Function CompanyNamePageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 18u "Enter the company name to display in the DropCopy Client:"
  Pop $0
  ${NSD_CreateText} 0 24u 100% 14u ""
  Pop $CompanyNameInput
  nsDialogs::Show
FunctionEnd

Function CompanyNamePageLeave
  ${NSD_GetText} $CompanyNameInput $0
  ${If} $0 == ""
    MessageBox MB_ICONEXCLAMATION|MB_OK "Please enter a company name."
    Abort
  ${EndIf}
  StrCpy $CompanyNameValue $0
FunctionEnd

!macro customInstall
  ; The app encrypts this one-time handoff on first launch and deletes it.
  WriteRegStr HKCU "Software\Sanjay\NSE BSE DropCopy Client" "CompanyName" $CompanyNameValue
!macroend
!endif
