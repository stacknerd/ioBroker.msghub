# IoIdCatalog (Message Hub IO): shared backend ID-catalog cache

`IoIdCatalog` owns the backend logic for config-facing ID-catalog commands.
It builds one reduced shared full-cache for ioBroker `state` objects and serves both flat and tree-oriented views from that same cache.

In short:

- `IoIdCatalog` is the backend owner for `config.idcatalog.*`.
- `IoIdCatalog` is not a command router and does not validate `payload.token`.

---

## Why this file exists

The ID-catalog backend needs shared cache ownership, shared TTL semantics, and one shared `meta` block.
That logic would make `IoAdminConfig` too wide and too stateful.

`IoIdCatalog` keeps that concern isolated so the config facade can stay thin while the catalog backend remains testable and documentable.

---

## System role

Simple flow:

1. ioBroker sends `sendTo(..., command='config.idcatalog.*', payload)`.
2. `main.js` routes the command to `IoAdminConfig.handleCommand(...)`.
3. `IoAdminConfig` validates `payload.token`, strips it from the business payload, and delegates to `IoIdCatalog`.
4. `IoIdCatalog` serves the response from one shared reduced backend full-cache.

References:

- backend owner: `lib/IoIdCatalog.js`
- routing facade: `lib/IoAdminConfig.js`

---

## Responsibilities

`IoIdCatalog` is responsible for:

1. Building one reduced shared backend full-cache from `getForeignObjects('*', 'state')`.
2. Applying one global TTL to that shared cache.
3. Exposing an explicit full reset.
4. Serving flat `get(filter)` views from the shared cache.
5. Serving tree-oriented `openTree(entry, depth)` views from the same shared cache.
6. Enforcing the hard projection whitelist:
   - `_id`
   - `common.name`
   - `common.type`
   - `common.role`
   - `common.unit`
7. Producing the shared `meta` block for both `get` and `openTree`.

---

## Non-responsibilities

`IoIdCatalog` is explicitly **not** responsible for:

1. Validating config tokens.
2. Routing `config.*` commands.
3. Writing frontend state or owning picker UI behavior.
4. Returning broader ioBroker object projections such as `native`, `acl`, `from`, `ts`, `read`, `write`, or `common.custom`.

---

## Cache model

The backend cache model is intentionally simple:

- one shared reduced full-cache for all ID-catalog commands
- one global TTL for the whole cache
- no subtree-specific TTLs
- no pseudo-lazy backend fetch model

The initial backend read always loads the full reduced state catalog.
After that, `get(...)` and `openTree(...)` only differ in response shape.

Default TTL:

- `30 minutes`

The TTL starts when the shared cache is built.
After expiry, the next request rebuilds the full cache from scratch.

---

## Shared `meta` block

`config.idcatalog.get` and `config.idcatalog.openTree` return the same `meta` shape:

```js
meta: {
  backendDurationMs,
  createdAt,
  ttlMs,
}
```

Semantics:

- `backendDurationMs`
  - duration of the concrete command
- `createdAt`
  - timestamp of the shared backend cache, not of the request
- `ttlMs`
  - global TTL of the shared backend cache

The shared `meta` block is produced from one common method in `IoIdCatalog` so the contract cannot drift between `get` and `openTree`.

---

## Command-facing behavior

### `get(filter)`

Purpose:

- return a flat reduced catalog view from the shared cache

Semantics:

- `filter` is optional
- fallback is `'*'`
- filtering happens against the shared cache, not through a narrower backend read

Result:

- `data.objects`
- `data.meta`

### `openTree(entry, depth)`

Purpose:

- return one tree-oriented slice from the shared cache

Payload:

- `entry`
  - optional subtree root
  - empty string means root
- `depth`
  - optional response depth
  - normalized to `1..8`

Result:

- `data.ancestors`
- `data.entry`
- `data.depth`
- `data.nodes`
- `data.meta`

Node semantics:

- `data.ancestors` contains the ordered path from root to the requested `entry`
- `data.ancestors` includes the requested `entry` itself
- ancestor-path responses do not auto-expand sideways into siblings on those levels
- nodes are grouped by the root instance prefix at the catalog root
- subtree responses stay relative to the requested `entry`
- `data.nodes` still describes only the downward response slice below `entry`
- exact state leaves carry the same reduced projection as `get(...)`
- structural nodes expose only tree metadata (`entry`, `parent`, `level`, `label`, `expandable`)

### `reset()`

Purpose:

- clear the shared backend cache completely

Result:

- `data.reset = true`
- `data.hadCache`

---

## Test coverage

- `lib/IoIdCatalog.test.js`

Covered areas include:

- shared full-cache creation
- hard whitelist projection
- shared `meta` block behavior
- root and subtree tree responses
- TTL expiry and rebuild
- explicit reset

---

## Related files

- implementation: `lib/IoIdCatalog.js`
- tests: `lib/IoIdCatalog.test.js`
- config facade: `lib/IoAdminConfig.js` / `docs/io/IoAdminConfig.md`
- IO API reference: `docs/io/API.md`
