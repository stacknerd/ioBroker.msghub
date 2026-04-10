# Admin Tab URL Parameters

This page documents the supported URL and hash inputs for `admin/tab.html` as implemented today.
The same canonical query targets are also the source for the prepared Public-Web URLs introduced by the `web` composition contract.

## Supported query parameters

| Parameter | Values | Behavior |
| --- | --- | --- |
| `instance` | integer-like | Selects the adapter instance. Invalid or missing values fall back to `0`, so the page uses `msghub.<instance>`. |
| `lang` | language code | Selects the initial UI language. Missing or blank values fall back to the browser base language. |
| `locale` | locale string | Overrides only the frontend format locale when the value is non-empty and accepted by `Intl.DateTimeFormat(...)`. Missing, blank, or invalid values leave the existing frontend format-locale source unchanged. |
| `composition` | composition id | Produces `web.view.get({ mode: 'composition', targetId })`. |
| `panel` | `tab-...` | Produces `web.view.get({ mode: 'panel', targetId })`. `panel` takes precedence over `composition`. |
| `expert` | `true`, `1`, bare `?expert`, or any other present value | Normalized by `runtime.js` only when the key is present. `true`, `1`, and bare `?expert` become `true`; every other present value becomes `false`. |
| `theme` | `dark`, `light` | Canonical theme override. When valid, it wins over host, storage, and media-query theme detection. |
| `react` | `dark`, `light` | Legacy theme alias. It is only consulted when `theme` is absent. |
| `debugTheme` | `true`, `1`, or bare `?debugTheme` | Debug-only flag. Only those values enable it. When enabled, `applyTheme(...)` mirrors the effective theme to `window.__msghubAdminTabTheme`. |

Unknown query keys are preserved on `args` and are available to native panels through `ctx.args`.

`locale` does not affect admin i18n loading, text language, plugin bundle language selection, or backend payloads.
It only overrides the browser-side format-locale source used by the shell when no more specific locale is supplied to `ctx.api.time.formatTs(...)` / `formatDate(...)`.

## Hash navigation

The hash is for panel navigation inside the already resolved composition:

- `#tab-messages`
- `#tab-plugins`
- `#tab-plugin-<PluginType>-<instanceId>-<panelId>`

`layout.js` reads `location.hash` once during `initTabs()`. It activates the matching tab only when that panel exists in the current composition and the tab is not disabled. The hash does not select a composition and it is not a wildcard fallback.

## Composition resolution

The active view request is resolved in this order:

1. `args.panel`
2. `args.composition`
3. `document.documentElement[data-msghub-view]`
4. backend default `adminTab`

`api.host.*`, `layout.js`, and `boot.js` all reflect the same loaded `web.view.get` result.

Important distinction:

- markup `data-msghub-view` and backend default `adminTab` are only fallbacks when no explicit `composition` query parameter is present
- an explicit but unknown `composition` id is forwarded to `web.view.get(...)` and rejected by the backend resolver; it does not fall back to markup or `adminTab`

## Theme priority and locking

Theme resolution behaves as follows:

1. Valid explicit URL override from `theme`.
2. Valid explicit URL override from legacy `react` when `theme` is absent.
3. Embedded host theme from the top window.
4. Theme-like values discovered in `localStorage`.
5. `prefers-color-scheme: dark`.
6. Hard fallback: `light`.

When a valid URL override is active, `runtime.js` sets the internal boolean `urlThemeLocked = true`.
`layout.js` then ignores host theme sync events (`message`, `storage`, polling, and mutation observer) so the explicit URL theme stays authoritative for the whole session.
This flag is shell-internal coordination state, not part of the public/native panel API and not part of the plugin-facing contract.

If `theme` is present but invalid, it still blocks the legacy `react` alias because `theme` is the canonical parameter. In that case there is no URL override and the runtime falls through to host/storage/media-query detection.

## Expert mode behavior

`expert` is an official URL parameter.

Current semantics:

- Native panels receive the normalized value through `ctx.args.expert`.
- `api.host.isExpertMode()` resolves expert mode additively from:
  - `args.expert === true`
  - `sessionStorage['App.expertMode'] === 'true'`
  - `window._system.expertMode` or `window.top._system.expertMode`
- The Messages panel uses the same additive model through `detectExpertMode(ctx.args?.expert)`.

Additive means:

- `?expert=1` or `?expert` forces expert mode on.
- `?expert=false` does not force expert mode off if the host/session is already in expert mode.

Today, the Messages panel uses expert mode to enable multi-selection and bulk delete controls.

## Defaults and fallback summary

- Missing/invalid `instance` -> `0`
- Missing/blank `lang` -> browser base language
- Missing/blank/invalid `locale` -> existing frontend format-locale source
- Missing/blank `composition` -> markup `data-msghub-view`, then `adminTab`
- Explicit unknown `composition` -> backend `web.view.get` error
- Invalid `theme` with no usable legacy alias -> host/storage/media-query theme pipeline
- Missing `expert` -> host/session expert detection only

## Examples

```text
/admin/tab.html?instance=0&lang=de#tab-messages
/admin/tab.html?instance=0&locale=de-DE#tab-messages
/admin/tab.html?instance=1&theme=dark#tab-plugins
/admin/tab.html?instance=1&composition=adminTab#tab-messages
/admin/tab.html?instance=1&composition=web
/admin/tab.html?instance=1&expert=1#tab-messages
/admin/tab.html?instance=1&react=dark
```

## Prepared Public-Web mapping

This package does not turn the Public-Web host on.
It only fixes the canonical target mapping that later host-specific routing must use:

- Admin-shell single-panel target: `?panel=tab-messages`
- Later canonical Public-Web app URL: `/msghubUi/<instance>/tab-messages/`
- Admin-shell web-root target: `?composition=web`
- Later canonical Public-Web root URL: `/msghubUi/<instance>/`
