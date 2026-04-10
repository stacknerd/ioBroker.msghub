# admin/tab/core-panel-bootstrap.js: host-owned core panel entry resolver

`core-panel-bootstrap.js` is the small host-owned bootstrap helper for AdminTab core panels.
It resolves the conventional entry path from the owner-local core panel key, loads that `entry.js`
exactly once, and validates the exported bootstrap contract before `boot.js` consumes it.

In short: this file is the host-owned bridge between backend-owned core panel identity (`'messages'`,
`'plugins'`, ...) and the frontend-owned conventional entry contract under `admin/tab/panels/<panelKey>/entry.js`.

---

## Where it sits in the system

This helper lives on the browser shell path and is loaded before [`./tab-boot.md`](./tab-boot.md).
The flow is:

1. `web.view.get` delivers a composition plus backend-owned `corePanels` identity data.
2. [`./tab-layout.md`](./tab-layout.md) renders the visible containers for those core panels.
3. `boot.js` asks `loadCorePanelEntry(panelId)` to resolve the host-owned entry for each core panel.
4. The helper loads `admin/tab/panels/<panelKey>/entry.js`, validates `{ css, js, panelInit(ctx) }`,
   and returns that frozen contract to `boot.js`.
5. `boot.js` loads the listed assets and finally calls `panelInit(ctx)`.

That split is important:

- the backend still owns the semantic truth that a core panel exists and belongs to the composition
- the browser host now owns the technical bootstrap truth for how that core panel starts

---

## Responsibilities

### 1) Resolve the conventional entry URL from the panel key

The helper works only from the owner-local core panel id, for example:

- `'messages'`
- `'plugins'`

It does **not** consult backend asset metadata, a second frontend registry, or a host-owned mapping table.
The path is derived conventionally as:

```text
admin/tab/panels/<panelKey>/entry.js
```

### 2) Load each entry exactly once per page lifetime

`loadCorePanelEntry(panelId)` caches the promise immediately.
That means concurrent callers share one in-flight load and the browser does not start multiple parallel loads
for the same entry script.

### 3) Validate the entry contract strictly

The loaded `entry.js` must expose its definition through `document.currentScript.__msghubCorePanelEntry`.
The helper then validates and freezes:

- `css` as a normalized string array
- `js` as a normalized string array
- `panelInit(ctx)` as the required init function

There is no compatibility bridge here:

- no backend-provided asset fallback
- no wrapper lookup through an old global panel API

---

## Public surface / integration points

### `loadCorePanelEntry(panelId)`

Loads one conventional core panel entry and returns:

```js
{
  css: string[],
  js: string[],
  panelInit(ctx)
}
```

Important behavior:

- invalid panel ids reject immediately
- missing `document.head` rejects immediately
- failed script loads reject with a visible load error for the caller
- invalid entry shapes reject and evict the cached promise so later retries are not poisoned by a bad result
- successful results are frozen before returning

### Internal helpers

The module also contains internal helper functions for:

- panel-key normalization
- conventional URL construction
- asset-list normalization
- final entry-contract validation

Those helpers are intentionally shell-local. The rest of the UI consumes only `loadCorePanelEntry(...)`.

---

## Design notes / invariants

- The helper is **host-owned**. It does not move technical bootstrap truth back into `web.view.get`.
- The helper is **convention-based**, not registry-based. The panel key is enough.
- The helper does **not** run panel code. Lifecycle execution stays in [`./tab-boot.md`](./tab-boot.md).
- The helper validates the final contract early so `boot.js` can treat entry loading as a normal boot error path.
- `entry.js` is the only active bootstrap document for core panels. The helper does not look for legacy global exports.

---

## Related files

- Implementation: [`admin/tab/core-panel-bootstrap.js`](../../admin/tab/core-panel-bootstrap.js)
- Boot consumer: [`./tab-boot.md`](./tab-boot.md)
- Layout mount containers: [`./tab-layout.md`](./tab-layout.md)
- UI-facing contract: [`./API.md`](./API.md)
