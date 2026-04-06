# admin/tab/registry.js: static source of truth for shell panels and compositions

`registry.js` defines the Admin Tab information architecture in one frozen object:

- which native panels exist
- which assets belong to them
- which compositions the shell can render
- which plugin panel slots are part of a composition

The rest of the shell reads this registry but does not redefine it.

---

## Where it sits in the system

The module is loaded very early by [`admin/tab.html`](../../admin/tab.html), directly after
[`./tab-globals.md`](./tab-globals.md).

That is deliberate: later files such as [`./tab-layout.md`](./tab-layout.md),
[`./tab-api.md`](./tab-api.md), and [`./tab-boot.md`](./tab-boot.md) all read from the registry
and assume it already exists.

---

## Responsibilities

### 1) Define native panel metadata

The current native panels are:

- `messages`
- `plugins`

Each native panel definition follows the producer-side core-panel shape:

- `id` — owner-local panel key (for example `'messages'` or `'plugins'`)
- `label` — i18n key string for the panel label
- `ui.kind` — always `'core'` for native panels
- `ui.loader` — always `'globals'` for native panels
- `ui.initGlobal` — name of the global init object (e.g. `'MsghubAdminTabMessages'`)
- `ui.css` — array of CSS asset paths relative to `admin/`
- `ui.js` — array of JS asset paths relative to `admin/`
- `category` — semantic group (not a styling field; carries no color values)
- `app?` — optional; PWA / install metadata (see below)

That gives the shell enough information to render the panel container, label the tab,
load the panel assets, and call the panel's `init(ctx)` entrypoint. `layout.js` derives the
canonical external/runtime id (`tab-...`) later from the owner-local `id`.

#### Optional `app` block

When a panel is intended to be installable as a PWA or surfaced in a standalone web context,
its descriptor may carry an `app` block. The current core pilot is `messages`; `plugins`
does not carry `app`.

Required fields within `app`:

- `name` — i18n key string; used for `application-name` meta and install dialog
- `url` — host-neutral single-panel target string. Current contract stores only the stable
  target params, for example `?panel=tab-messages`. The shell resolves that target against
  the current entry path at runtime when it builds manifest `start_url` / `id`.

Optional fields within `app`:

- `shortName` — shorter variant; falls back to `name` when absent
- `display` — install/display hint such as `'standalone'`
- `themeColor` — CSS color string for the `theme-color` meta tag
- `backgroundColor` — background color hint for install surfaces
- `icons` — fixed slot-to-filename mapping with `any192`, `any512`, `maskable192`,
  `maskable512`, and `apple180`

The producer stores filenames only. The host owns deterministic path resolution from panel ownership
and slot; the producer does not embed host-facing paths.

### 2) Define view compositions

The current registry exposes these compositions:

- `adminTab`
- `full`
- `web`
- `messagesSingle`

Their current roles are:

- `adminTab`: default tabbed admin view with native panels plus selected plugin panel slots
- `full`: wildcard tabbed view that renders all native panels and all discovered plugin panel contributions
- `web`: manually curated composition that is the prepared source of truth for the future Public-Web root
- `messagesSingle`: dedicated single-layout view for the native `messages` panel

### Special-case `app` block on composition `web`

Normally, `app` belongs to panel descriptors.
The only deliberate exception is the composition `web`.

Its `app` block does not make the Public-Web root live in the Admin host.
It only fixes the canonical metadata source for the later web root:

- canonical composition target: `?composition=web`
- later canonical public root: `/msghubUi/<instance>/`
- later internal resolution on that host: `/msghubUi/<instance>/tab.html?composition=web`

### 3) Declare plugin panel slots without turning them into native panels

The current `adminTab` composition contains one active structured plugin panel ref:

- `IngestStates` instance `0`, panel `presets`

These refs are part of the composition, but they are intentionally **not** entries in `registry.panels`.
They are hydrated later through plugin discover data.

---

## Public surface / integration points

The module writes one global object:

```js
window.MsghubAdminTabRegistry
```

Its shape is:

```js
{
  panels,
  compositions
}
```

Consumers:

- [`./tab-layout.md`](./tab-layout.md) builds DOM and asset lists from it.
- [`./tab-api.md`](./tab-api.md) derives host metadata such as `viewId`, `layout`, and native `host.panels`.
- [`./tab-boot.md`](./tab-boot.md) uses it to initialize native panels and plugin panel slots.

---

## Design notes / invariants

- The registry is created once inside an IIFE. If `window.MsghubAdminTabRegistry` already exists, the module leaves it unchanged.
- The exported object and its nested panel/composition definitions are frozen.
- `registry.panels` is native-only. Structured plugin panel refs belong in `composition.panels`, not in `registry.panels`.
- `surface` is no longer part of the active producer contract for panels or compositions.
- Asset paths are stored relative to `admin/`, because the shell asset loaders append them directly as page URLs.
- `defaultPanel` is a plain string. Native defaults use the owner-local panel key (`'messages'`, `'plugins'`); plugin defaults may still resolve to a plugin panel DOM key such as `plugin-...`.

---

## Related files

- Implementation: [`admin/tab/registry.js`](../../admin/tab/registry.js)
- Test: [`admin/tab/registry.test.js`](../../admin/tab/registry.test.js)
- Layout consumer: [`./tab-layout.md`](./tab-layout.md)
- Boot consumer: [`./tab-boot.md`](./tab-boot.md)
- API consumer: [`./tab-api.md`](./tab-api.md)
