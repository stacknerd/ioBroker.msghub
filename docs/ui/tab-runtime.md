# admin/tab/runtime.js: runtime globals for query parsing, transport, i18n, and theme state

`runtime.js` prepares the shell's long-lived browser runtime state.
It answers the basic questions the rest of the shell depends on:

- which adapter instance is this page talking to?
- what language is active?
- is there a frontend format-locale override?
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
2. `api.js`
3. `runtime.js`
4. `ui.js`
5. `scroll-strip.js`
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

`runtime.js` also defines the initial browser-side source for optional URL overrides such as
`composition`, `expert`, `theme`, and `locale`, even though some of those values are only consumed
later by [`./tab-layout.md`](./tab-layout.md), [`./tab-api.md`](./tab-api.md), or panel code.

---

## Responsibilities

### 1) Parse URL query parameters into usable runtime state

`parseQuery()` normalizes the page query into `args`.
Notable behavior:

- `instance` defaults to `0` and is coerced to an integer
- `lang` falls back to the browser base language when missing or blank
- `locale` is trimmed and removed when blank
- `composition` is trimmed and removed when blank
- `panel` is trimmed and removed when blank; consumed downstream to activate Single-Panel mode
- `expert` is normalized only when the key is present
- `theme` and `react` stay raw so later theme helpers can apply the canonical precedence rules
- `debugTheme` stays raw in `args` and is normalized separately at module load
- unknown keys are preserved

Invalid URL encoding is handled defensively: undecodable query fragments fall back to their raw key/value
strings instead of aborting shell bootstrap.

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

For `admin.*`, `config.*`, and `web.*`, that wrapper also owns the central capability-token flow:

- startup bootstrap via `ui.bootstrap`
- cached `{ capabilities, about }`
- automatic `payload.token` injection by namespace
- refresh when the current grant has less than 15 minutes remaining lifetime
- exactly one forced re-bootstrap retry on the first token-related command failure of the current browser session

This keeps token logic out of panels, `api.js`, and the plugin UI host.

### 3) Load and serve the shell i18n dictionary

The module owns the admin dictionary state:

- `adminDict`
- `adminDictPromise`

`ensureAdminI18nLoaded()` always loads `i18n/en.json` as the base dictionary.
If `lang !== 'en'`, it additionally loads `i18n/<lang>.json` and overlays it on top of the English base.
If `lang === 'en'`, no second language file is fetched.

Note: these paths are admin-relative URLs served by the ioBroker host from `admin/i18n/<lang>.json` in the repo.
They are the Admin Tab i18n source (`admin/i18n/`) and are unrelated to the backend runtime catalog at `i18n/` in the repo root.
The shell never treats repo-root `i18n/*` as a fallback source for Admin Tab text.

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

The runtime owns the explicit URL theme override contract through:

- `resolveExplicitUrlTheme(query)`
- `resolveTheme(query)`
- `readThemeFromLocalStorage()`
- `readThemeFromTopWindow()`
- `detectTheme()`
- `applyTheme(nextTheme)`

Key rules:

- `theme` is the canonical query parameter
- `react` is the legacy alias and is consulted only when `theme` is absent
- if `theme` is present but invalid, the legacy alias is still blocked
- `detectTheme()` resolves in this order:
  1. valid explicit URL override from `theme`
  2. valid explicit URL override from legacy `react`
  3. embedded host theme via `readThemeFromTopWindow()`
  4. theme-like values from `localStorage`
  5. `prefers-color-scheme: dark`
  6. hard fallback `light`

The selected theme is written to:

```html
<html data-msghub-theme="dark|light">
```

When a valid explicit URL override exists, `runtime.js` also sets `urlThemeLocked = true`.
That flag is internal runtime coordination state used by [`./tab-layout.md`](./tab-layout.md) to suppress
later host-driven theme sync paths for the rest of the session.

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
- `sendRawRequest(command, message)` — internal raw transport used only by the bootstrap/token wrapper

### i18n

- `ensureAdminI18nLoaded()`
- `hasAdminKey(key)`
- `mergePluginI18n(pluginType, translations)`
- `t(key, ...args)`
- `overrideLang(newLang)`
- `pickText(value)` — resolves a label to a display string: translates i18n-key strings via `t()`, passes through plain strings, and bridges legacy `{en, de}` language maps using the active `lang`

### Theme

- `readThemeFromTopWindow()`
- `applyTheme(nextTheme)`
- `detectTheme()`

Internal shell-only coordination state:

- `urlThemeLocked`

Main consumers:

- [`./tab-api.md`](./tab-api.md)
- [`./tab-layout.md`](./tab-layout.md)
- [`./tab-boot.md`](./tab-boot.md)
- [`./tab-plugin-ui-host.md`](./tab-plugin-ui-host.md)

---

## Design notes / invariants

- The socket path is always `/socket.io`, independent of whether the page is served from an admin path or an adapter path.
- `msghubRequest(...)` resolves with backend payload data, not with the outer `{ ok, data }` transport envelope.
- `msghubRequest(...)` is the only browser-side token attachment point for `admin.*`, `config.*`, and `web.*`.
- `ui.bootstrap` itself stays outside the token-protected namespaces but shares the same cached bootstrap state.
- `ensureAdminI18nLoaded()` caches the load promise. Repeated callers share the same in-flight work.
- `overrideLang(...)` resets the cached dictionary promise so a later load can fetch the new language.
- Plugin i18n merging is intentionally one-way and additive. Existing keys are never overwritten.
- Admin-UI text loading stays in the `admin/i18n/*` namespace. The repo-root `i18n/*` tree is reserved for backend/runtime catalogs and should not be mixed into the shell dictionary.
- Unknown query keys remain available to native panels through `ctx.args`.
- `runtime.js` parses `composition`, `panel`, and `expert`, but their consumption happens downstream: composition resolution in [`./tab-layout.md`](./tab-layout.md), panel-mode activation in [`./tab-boot.md`](./tab-boot.md), expert-mode capabilities in panel/API concerns.
- `panel` activates Single-Panel mode when set; it must carry a `tab-` prefix. Unresolvable targets render a hard error. `panel` takes precedence over `composition` when both are present.
- `locale` is only a browser-side format-locale override source. It does not change admin i18n loading, text language, plugin bundle language selection, or backend payloads.
- The token refresh flow does not change the three language/locale channels. `backendTextLanguage`, `coreTextLanguage`, and `coreFormatLocale` remain separate semantics in the bootstrap payload.
- `urlThemeLocked` is an internal inter-module flag, not a native-panel API and not a plugin-facing contract.
- The theme is applied immediately at module load to reduce visual flicker.
- `applyTheme(...)` is idempotent for the current DOM state and optionally writes `window.__msghubAdminTabTheme` when `debugTheme` is enabled.

---

## Related files

- Implementation: [`admin/tab/runtime.js`](../../admin/tab/runtime.js)
- Test: [`admin/tab/runtime.test.js`](../../admin/tab/runtime.test.js)
- URL guide: [`./url-parameters.md`](./url-parameters.md)
- API facade built on top of this runtime: [`./tab-api.md`](./tab-api.md)
- Layout theme consumer: [`./tab-layout.md`](./tab-layout.md)
- Boot orchestration: [`./tab-boot.md`](./tab-boot.md)
- Plugin i18n caller: [`./tab-plugin-ui-host.md`](./tab-plugin-ui-host.md)
