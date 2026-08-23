; _FriendTradeGoToSocialHub.ahk -- creado 2026-08-23, a pedido explicito del usuario: separado
; de _FriendTradeCheckPendingOffer.ahk para tener un paso propio y reusable que solo navega
; desde "Search Results" (justo despues de que _SendFriendRequest.ahk manda la solicitud)
; hasta Social Hub, cerrando los dialogos intermedios que puede dejar abiertos el juego --
; SIN entrar todavia a Trade. Mismos 4 primeros taps que ya usaba _SendTradeCard.ahk (pasos
; 1-4), ahora en su propio archivo para poder reusarlo antes de cualquier accion futura, no
; solo el chequeo de oferta pendiente.
;
; Uso: _FriendTradeGoToSocialHub.ahk "<winTitle>" "<folderPath>" "<outputFile>"
;   Escribe "OK" siempre que llegue a correr los 4 taps (no verifica pantalla con needle,
;   son dialogos que pueden o no estar abiertos -- cerrar uno que no existe es inofensivo).

#SingleInstance off
SetBatchLines, -1
#NoEnv

if (A_Args.Length() < 3) {
    ExitApp, 1
}

global g_winTitle   := A_Args[1]
global g_folderPath := A_Args[2]
global g_outputFile := A_Args[3]

#Include %A_ScriptDir%\_AdbUtils.ahk

WriteResult(text) {
    global g_outputFile
    try {
        if (FileExist(g_outputFile))
            FileDelete, %g_outputFile%
        FileAppend, %text%, %g_outputFile%
    } catch e {
    }
}

adbPath := resolverRutaAdb(g_folderPath)
if (adbPath = "") {
    WriteResult("ERROR: adb_no_encontrado")
    ExitApp, 3
}
puerto := resolverPuertoAdb(g_folderPath, g_winTitle)
if (puerto = "") {
    WriteResult("ERROR: puerto_no_encontrado")
    ExitApp, 3
}
AdbConectar(adbPath, puerto)

tap(x, y, esperaMs := 4000) {
    static convX := 540/283, convY := 960/488, offset := 40
    global adbPath, puerto
    AdbTap(adbPath, puerto, Round(x * convX), Round((y - offset) * convY))
    Sleep, %esperaMs%
}

tap(140, 500)   ; 1. Search Results -> X (cerrar)
tap(83, 360)    ; 2. Friend ID Search -> Cancel
tap(140, 500)   ; 3. Add Friend (QR) -> X (cerrar)
tap(140, 500)   ; 4. Friends -> X (cerrar)

WriteResult("OK")
ExitApp, 0
