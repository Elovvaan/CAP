Set shell = CreateObject("WScript.Shell")
Set filesystem = CreateObject("Scripting.FileSystemObject")

appFolder = filesystem.GetParentFolderName(WScript.ScriptFullName)
launcher = filesystem.BuildPath(appFolder, "launch-cap.cjs")
node = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
logFile = filesystem.BuildPath(appFolder, "cap-launch.log")
edge = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe"
edgeX86 = shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"
url = "http://127.0.0.1:1420/"

If Not filesystem.FileExists(node) Then
  MsgBox "CAP could not find Node.js at " & node & ". Please install Node.js or ask Codex to build the native app.", vbExclamation, "CAP"
  WScript.Quit 1
End If

shell.CurrentDirectory = appFolder
shell.Run """" & node & """ """ & launcher & """ > """ & logFile & """ 2>&1", 0, False
WScript.Sleep 1800

If filesystem.FileExists(edge) Then
  shell.Run """" & edge & """ --app=""" & url & """", 1, False
ElseIf filesystem.FileExists(edgeX86) Then
  shell.Run """" & edgeX86 & """ --app=""" & url & """", 1, False
Else
  shell.Run """" & url & """", 1, False
End If
