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

Each native panel definition contains:

- `id`
- `mountId`
- `titleKey`
- `initGlobal`
- `assets.css`
- `assets.js`

That gives the shell enough information to render the panel container, label the tab,
load the panel assets, and call the panel's `init(ctx)` entrypoint.

### 2) Define view compositions

The current registry exposes these compositions:

- `adminTab`
- `full`
- `messagesSingle`

Their current roles are:

- `adminTab`: default tabbed admin view with native panels plus selected plugin panel slots
- `full`: wildcard tabbed view that renders all native panels and all discovered plugin panel contributions
- `messagesSingle`: dedicated single-layout view for the native `messages` panel

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
- Asset paths are stored relative to `admin/`, because the shell asset loaders append them directly as page URLs.
- `defaultPanel` is a plain string. It may resolve either to a native panel ID or to a plugin panel DOM key such as `plugin-...`.

---

## Related files

- Implementation: [`admin/tab/registry.js`](../../admin/tab/registry.js)
- Test: [`admin/tab/registry.test.js`](../../admin/tab/registry.test.js)
- Layout consumer: [`./tab-layout.md`](./tab-layout.md)
- Boot consumer: [`./tab-boot.md`](./tab-boot.md)
- API consumer: [`./tab-api.md`](./tab-api.md)
