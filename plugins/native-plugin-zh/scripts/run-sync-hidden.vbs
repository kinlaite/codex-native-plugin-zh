Option Explicit

Dim shell, fso, baseDir, ps1
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(baseDir, "run-sync.ps1")

If Not fso.FileExists(ps1) Then
  WScript.Quit 2
End If

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = baseDir
shell.Run "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & ps1 & """", 0, False
