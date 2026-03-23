# IoPluginGuards: small runtime guard helpers for plugin ctx checks

`lib/IoPluginGuards.js` is part of the Message Hub IO/runtime layer.

It provides tiny validation helpers that built-in plugins can call when they want to fail fast on missing runtime wiring.

---

## Where it sits in the system

`IoPluginGuards` is intentionally very small and low-level.
It is not a plugin host and not an adapter bridge.

Its role is to support plugin code such as `Ingest*`, `Notify*`, `Bridge*`, and `Engage*` modules when they want to assert:

- required `ctx.api.*` objects exist,
- required `ctx.meta.*` objects exist,
- specific members are functions or non-empty strings.

That keeps fail-fast wiring checks readable without moving plugin-specific requirements into `IoPlugins`.

---

## Responsibilities

`IoPluginGuards` is responsible for:

1. Resolving dotted paths from a ctx-like object.
2. Normalizing guard-path strings such as `ctx.api.log`.
3. Validating required plain objects.
4. Validating required functions.
5. Validating required non-empty strings.
6. Throwing clear, prefix-based errors when the runtime contract is not present.

---

## Public API / contract surface

### `isPlainObject(v)`

Returns `true` for non-null, non-array objects.

This is the basic shape check used throughout the guard module.

### `getPath(root, path)`

Resolves a dotted path from a root object.

Examples:

- `getPath(ctx, 'api.log')`
- `getPath(ctx, 'ctx.api.log')`

Behavior:

- strips an initial `ctx.` prefix if present
- returns `undefined` when the path is invalid or traversal stops on a non-object

### `ensureCtxAvailability(prefix, ctx, req = {})`

Main exported guard helper.

Supported requirement groups:

- `req.plainObject: string[]`
- `req.fn: string[]`
- `req.stringNonEmpty: string[]`

Behavior:

- validates `ctx` itself is a plain object
- validates each configured path group
- throws `Error` with messages like:
  - `<prefix>: ctx must be a plain object`
  - `<prefix>: api.log must be a plain object`
  - `<prefix>: meta.plugin.baseOwnId must be a non-empty string`
- returns the original `ctx` for convenience

---

## Design notes / invariants

- This module is deliberately narrow: it validates presence and shape, not full semantic correctness.
- It does not know plugin categories or plugin manifests.
- It does not mutate `ctx`.
- It is safe to use in plugin `start(ctx)` paths for readable fail-fast checks.
- It is optional: some built-in plugins use it heavily, others rely more directly on the runtime contract.

---

## Related files

- Implementation: `lib/IoPluginGuards.js`
- Typical caller: built-in plugins under `lib/*/index.js`
- Runtime owner of the ctx contract: `lib/IoPlugins.js`
- IO overview: `docs/io/README.md`
