' Abre el Gestor de obras sin ventana de consola. Si ya esta arrancado, solo abre el navegador.
' La primera instalacion de los modulos (node_modules) se hace con Gestor.cmd, que muestra el progreso.
' El gestor se apaga solo unos minutos despues de cerrar la pestana (o con el boton Cerrar el gestor).
Option Explicit
Dim sh, fso, raiz, direccion
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
raiz = fso.GetParentFolderName(WScript.ScriptFullName)
direccion = "http://localhost:5180/"

If Not fso.FolderExists(raiz & "\node_modules\onnxruntime-node") Then
  sh.Run """" & raiz & "\Gestor.cmd""", 1, False
  WScript.Quit
End If

If Arrancado(direccion & "api/estado") Then
  sh.Run direccion, 1, False
Else
  sh.CurrentDirectory = raiz
  sh.Run "node ""herramientas\gestor.js""", 0, False
End If

Function Arrancado(url)
  Dim http
  On Error Resume Next
  Set http = CreateObject("MSXML2.XMLHTTP")
  http.Open "GET", url, False
  http.Send
  Arrancado = (Err.Number = 0 And http.Status = 200)
  On Error GoTo 0
End Function
