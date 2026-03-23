# admin/tab/runtime.js: runtime globals for query parsing, transport, i18n, and theme state

`runtime.js` prepares the shell's long-lived browser runtime state.
It answers the basic questions the rest of the shell depends on:

- which adapter instance is this page talking to?
- what language is active?
- how do we send admin commands?
- which admin i18n dictionary is loaded?
- which theme should the shell use?

Without this module, the higher-level shell code would have no stable transport or environment baseline.

---

## Where it sits in the system

`runtime.js` is loaded after [`./tab-api.md`](./tab-api.md) and before
[`./tab-ui.md`](./tab-ui.md), [`./tab-layout.md`](./tab-layout.md), and [`./tab-boot.md`](./tab-boot.md).

The current HTML load order in [`admin/tab.html`](../../admin/tab.html) is:

1. `globals.js`
2. `registry.js`
3. `api.js`
4. `runtime.js`
5. `ui.js`
6. `layout.js`
7. `plugin-ui-host.js`
8. `boot.js`
9. `tab.js`

Those later files assume that `runtime.js` already created:

- `args`
- `adapterInstance`
- `window.msghubSocket`
- `msghubRequest(...)`
- `lang`
- translation helpers
- theme helpers

---

## Responsibilities

### 1) Parse URL query parameters into usable runtime state

`parseQuery()` normalizes the page query into `args`.
Notable behavior:

- `instance` defaults to `0`
- `instance` is coerced to an integer
- `lang` falls back to the browser language when missing

The module then derives:

```js
const adapterInstance = `msghub.${args.instance}`;
```

### 2) Create the browser-to-backend transport bridge

`createSocket()` connects through socket.io using:

```js
io.connect('/', { path: '/socket.io' })
```

`msghubRequest(command, message)` wraps the `sendTo` pattern and resolves with `res.data` on success.
If the backend reports an error, the promise rejects with a normal `Error`.

### 3) Load and serve the shell i18n dictionary

The module owns the admin dictionary state:

- `adminDict`
- `adminDictPromise`

`ensureAdminI18nLoaded()` always loads `i18n/en.json` as the base dictionary.
If `lang !== 'en'`, it additionally loads `i18n/<lang>.json` and overlays it on top of the English base.
If `lang === 'en'`, no second language file is fetched.

Translation access then happens through:

- `hasAdminKey(key)`
- `t(key, ...args)`

### 4) Merge plugin-owned UI translations into the runtime dictionary

`mergePluginI18n(pluginType, translations)` is the mutation point used by
[`./tab-plugin-ui-host.md`](./tab-plugin-ui-host.md).

It accepts only keys that:

- start with `msghub.i18n.<pluginType>.ui.`
- do not already exist in the dictionary

That keeps plugin UI translations additive and namespace-bounded.

### 5) Detect and apply the shell theme

The runtime also provides theme helpers:

- `resolveTheme(query)`
- `readThemeFromLocalStorage()`
- `readThemeFromTopWindow()`
- `detectTheme()`
- `applyTheme(nextTheme)`

The selected theme is written to:

```html
<html data-msghub-theme="dark|light">
```

---

## Public surface / integration points

This module exposes classic-script globals rather than a single exported object.

### Runtime globals

- `args`
- `adapterInstance`
- `window.msghubSocket`
- `lang`
- `isEmbeddedInAdmin`

### Transport

- `msghubRequest(command, message)`

### i18n

- `ensureAdminI18nLoaded()`
- `hasAdminKey(key)`
- `mergePluginI18n(pluginType, translations)`
- `t(key, ...args)`
- `overrideLang(newLang)`

### Theme

- `readThemeFromTopWindow()`
- `applyTheme(nextTheme)`
- `detectTheme()`

Main consumers:

- [`./tab-api.md`](./tab-api.md)
- [`./tab-layout.md`](./tab-layout.md)
- [`./tab-boot.md`](./tab-boot.md)
- [`./tab-plugin-ui-host.md`](./tab-plugin-ui-host.md)

---

## Design notes / invariants

- The socket path is always `/socket.io`, independent of whether the page is served from an admin path or an adapter path.
- `msghubRequest(...)` resolves with backend payload data, not with the outer `{ ok, data }` transport envelope.
- `ensureAdminI18nLoaded()` caches the load promise. Repeated callers share the same in-flight work.
- `overrideLang(...)` resets the cached dictionary promise so a later load can fetch the new language.
- Plugin i18n merging is intentionally one-way and additive. Existing keys are never overwritten.
- `detectTheme()` gives precedence to local storage, then host-window hints, then the initial query-derived theme, then `prefers-color-scheme`.
- `applyTheme(...)` is idempotent for the current DOM state and optionally writes `window.__msghubAdminTabTheme` when `debugTheme` is enabled.

---

## Related files

- Implementation: [`admin/tab/runtime.js`](../../admin/tab/runtime.js)
- Test: [`admin/tab/runtime.test.js`](../../admin/tab/runtime.test.js)
- API facade built on top of this runtime: [`./tab-api.md`](./tab-api.md)
- Layout theme consumer: [`./tab-layout.md`](./tab-layout.md)
- Boot orchestration: [`./tab-boot.md`](./tab-boot.md)
- Plugin i18n caller: [`./tab-plugin-ui-host.md`](./tab-plugin-ui-host.md)
