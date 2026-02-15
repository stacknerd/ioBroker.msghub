/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/* global window */
'use strict';

/*
 * MsgHub Admin Tab: globale Laufzeit-Bindings.
 *
 * Inhalt:
 * - Zentrale Referenz auf das Browser-`window` (`win`) für alle Teilmodule.
 * - Zugriff auf socket.io (`io`), das in `admin/tab.html` vorab geladen wird.
 *
 * Systemeinbindung:
 * - Dieses Modul ist der erste Baustein in der Ladereihenfolge von `admin/tab.html`.
 * - Nachfolgende Module (`registry.js`, `api.js`, `runtime.js`, ...) nutzen diese Variablen.
 *
 * Schnittstellen:
 * - Exportiert keine ES-Module, sondern legt Dateiscope-Variablen für die sequenziell
 *   geladenen Scripts an.
 */
const win = window;
const io = win.io;
void io;
