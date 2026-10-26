' Black hole launcher: start backend + frontend silently, open Edge app window
Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
ws.CurrentDirectory = root

' 0) Build frontend if dist missing (first run after clone)
distIndex = root & "\gui\dist\index.html"
If Not fso.FileExists(distIndex) Then
  ws.Run "cmd /c node gui\node_modules\vite\bin\vite.js build", 0, True
End If

' 1) Backend API :7700
ws.Run "cmd /c node src\server\api.js >nul 2>&1", 0, False

' 2) Frontend :5173 (static server for gui/dist)
ws.Run "cmd /c node src\server\static.js >nul 2>&1", 0, False

WScript.Sleep 8000

' 3) Edge app window
edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
If Not fso.FileExists(edge) Then edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
profile = ws.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\BlackHole\edge-profile"
If Not fso.FolderExists(profile) Then fso.CreateFolder(profile)
ws.Run """" & edge & """" & " --app=http://127.0.0.1:5173/ --user-data-dir=""" & profile & """ --no-first-run --no-default-browser-check", 1, False