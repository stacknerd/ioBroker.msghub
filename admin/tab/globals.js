/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/* global window */
'use strict';

/**
 * MsgHub Admin Tab: global runtime bindings.
 *
 * Docs: ../../docs/ui/tab-globals.md
 *
 * Contents:
 * - Central reference to the browser `window` (`win`) for all submodules.
 * - Access to socket.io (`io`), which is loaded in advance by `admin/tab.html`.
 *
 * Integration:
 * - This module is the first building block in the load order of `admin/tab.html`.
 * - Subsequent modules (`api.js`, `runtime.js`, ...) use these variables.
 *
 * Interfaces:
 *
 * - Does not export ES modules; instead it defines file-scope variables for the
 *   sequentially loaded scripts.
 */
const win = window;
const io = win.io;
void io;
