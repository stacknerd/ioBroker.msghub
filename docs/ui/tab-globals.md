# admin/tab/globals.js: minimal global bindings for classic script loading

`globals.js` is the smallest shell module, but it establishes the naming convention that the other
classic scripts rely on.

It binds:

- `win` to `window`
- `io` to `window.io`

The rest of the Admin Tab then uses those file-scope globals instead of repeating direct `window` access.

---

## Where it sits in the system

This is the first JavaScript file loaded by [`admin/tab.html`](../../admin/tab.html) after `socket.io.js`.

That makes it the starting point for the shell's classic-script environment:

1. `socket.io.js` defines `window.io`
2. `globals.js` captures `window` and `window.io`
3. later shell files read `win` and `io`

---

## Responsibilities

### 1) Provide a stable alias for the browser global object

The file defines:

```js
const win = window;
```

That keeps later files consistent and avoids repeated direct global lookups.

### 2) Provide access to the preloaded socket.io client

The file also defines:

```js
const io = win.io;
```

`runtime.js` then uses that binding to create `window.msghubSocket`.

### 3) Establish the shared classic-script scope

This project does not use ESM imports for the Admin Tab shell.
`globals.js` is therefore part of the contract that makes the ordered `<script>` loading model work.

---

## Public surface / integration points

There is no exported object.
The public effect is the existence of the file-scope globals declared in [`admin/tab/contracts.d.ts`](../../admin/tab/contracts.d.ts):

- `win`
- `io`

Main consumers:

- `io`: [`./tab-runtime.md`](./tab-runtime.md)
- `win`: [`./tab-layout.md`](./tab-layout.md), [`./tab-boot.md`](./tab-boot.md), and [`./tab-runtime.md`](./tab-runtime.md)

---

## Design notes / invariants

- The file is intentionally tiny. It should stay a binding layer, not become a utility module.
- It is safe for this file itself when `window.io` is missing. In that case `io` is simply `undefined`; the actual failure would happen later when [`./tab-runtime.md`](./tab-runtime.md) tries to create the socket connection.
- Because the shell uses classic scripts, this file depends on load order rather than import statements.

---

## Related files

- Implementation: [`admin/tab/globals.js`](../../admin/tab/globals.js)
- Test: [`admin/tab/globals.test.js`](../../admin/tab/globals.test.js)
- Runtime consumer: [`./tab-runtime.md`](./tab-runtime.md)
- Type declarations: [`admin/tab/contracts.d.ts`](../../admin/tab/contracts.d.ts)
- HTML loader order: [`admin/tab.html`](../../admin/tab.html)
