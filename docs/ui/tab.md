# admin/tab.js: thin entry marker for the Admin Tab shell

`admin/tab.js` is the last JavaScript file loaded by [`admin/tab.html`](../../admin/tab.html).
It does not start the UI itself. The real boot process already happened in the previously loaded
modules under `admin/tab/`.

Its only purpose is to provide a stable, explicit marker that the browser reached the end of the
Admin Tab asset chain.

---

## Where it sits in the system

The Admin Tab is served as a classic browser page, not as an ES-module bundle.
[`admin/tab.html`](../../admin/tab.html) loads the core scripts in a fixed order:

1. globals
2. API helpers
3. runtime
4. UI primitives
5. layout helpers
6. plugin UI host
7. boot orchestration
8. this file

That makes `admin/tab.js` the final shell-level script in the page.

---

## Responsibilities

`admin/tab.js` is intentionally minimal:

1. Mark that the Admin Tab entry file was loaded successfully.
2. Provide a simple global sentinel for tests or host-side diagnostics.
3. Keep the page-level entrypoint stable while the real implementation stays in smaller files under `admin/tab/`.

---

## Public surface / integration points

The file sets exactly one global flag:

```js
window.__msghubAdminTabEntryLoaded = true;
```

This is not a runtime API for panels.
It is a page-level marker that can be checked after the shell finished loading.

---

## Design notes / invariants

- `admin/tab.js` must stay side-effect-light. Bootstrapping, socket work, DOM composition, and panel init belong in [`./tab-boot.md`](./tab-boot.md), not here.
- The file assumes that all other core scripts were already loaded by [`admin/tab.html`](../../admin/tab.html).
- Because the Admin Tab uses classic `<script>` tags, this file has no imports or exports.

---

## Related files

- Implementation: [`admin/tab.js`](../../admin/tab.js)
- Test: [`admin/tab.test.js`](../../admin/tab.test.js)
- HTML shell: [`admin/tab.html`](../../admin/tab.html)
- Stylesheet entry: [`admin/tab.css`](../../admin/tab.css)
- Shell orchestration: [`./tab-boot.md`](./tab-boot.md)
- Layout and asset loading: [`./tab-layout.md`](./tab-layout.md)
- Admin frontend overview: [`./README.md`](./README.md)
