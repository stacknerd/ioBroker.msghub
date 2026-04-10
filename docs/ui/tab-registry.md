# Backend UI Registry and View Contract

The AdminTab no longer owns a browser-local registry.

The canonical shell metadata now lives in:

- [`lib/IoUiRegistry.js`](../../lib/IoUiRegistry.js) as backend-owned SSoT for `panels` and `compositions`
- [`lib/IoUiCatalog.js`](../../lib/IoUiCatalog.js) as the backend resolver for `web.view.get`

The browser consumes only the active view payload:

```js
{ composition, corePanels, request }
```

## `web.view.get`

Request:

```js
{ mode, targetId? }
```

Rules:

- `mode: 'composition'`
  - no `targetId` => default composition `adminTab`
  - valid `targetId` => that composition
  - invalid `targetId` => error
- `mode: 'panel'`
  - `targetId` is required
  - formally valid targets become a synthetic single composition
  - no runtime availability check is performed

Response:

```js
{ composition, corePanels, request }
```

Meaning:

- `composition` remains the leading shell structure
- `corePanels` contains only resolved core panel definitions
- plugin-owned panel definitions stay plugin-owned and are not mirrored into `corePanels`
- wildcard compositions keep `panels: ['*']`

Current implementation note:

- for native/core panels, the backend-owned registry truth still includes concrete shell bootstrap metadata in `corePanels[*].ui`, including `loader`, `initGlobal`, `css`, and `js`
- `layout.js` and `boot.js` currently consume those fields directly for native panel asset loading and startup
- this is the current backend-owned contract as implemented today, not a more abstract future target

## Model invariants

- `IoUiRegistry.panels` contains only core panels.
- `composition.panels` may contain:
  - core panel string ids
  - structured `{ type: 'pluginPanel', ... }` refs
  - `'*'`
- the composition-level `app` exception remains `compositions.web.app`
- synthetic panel compositions use `id = 'comp-<panelId>'`

## Frontend implications

- [`admin/tab.html`](../../admin/tab.html) no longer loads `tab/registry.js`
- `layout.js`, `api.js`, and `boot.js` work from the loaded view payload
- `web.pluginUi.discover` remains the separate plugin-owned hydration channel

## Related files

- Backend registry: [`lib/IoUiRegistry.js`](../../lib/IoUiRegistry.js)
- Backend catalog: [`lib/IoUiCatalog.js`](../../lib/IoUiCatalog.js)
- Backend tests: [`lib/IoUiRegistry.test.js`](../../lib/IoUiRegistry.test.js), [`lib/IoUiCatalog.test.js`](../../lib/IoUiCatalog.test.js)
- Layout consumer: [`./tab-layout.md`](./tab-layout.md)
- Boot consumer: [`./tab-boot.md`](./tab-boot.md)
- API consumer: [`./tab-api.md`](./tab-api.md)
