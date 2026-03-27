# IoRuntimeI18n: source-aware backend i18n registry

`lib/IoRuntimeI18n.js` is part of the Message Hub IO/runtime layer.

`IoRuntimeI18n` is the central backend i18n registry.
It manages named translation sources, merges them lazily by priority, and provides closure-based translator facades that remain live without recreation when sources change.

---

## Where it sits in the system

`IoRuntimeI18n` is the layer between:

- the static i18n source files loaded by `main.js` (`i18n/` and `lib/_generated/backend-i18n/root-admin/`),
- plugin-owned backend i18n directories loaded by `IoPlugins` (`lib/<PluginType>/i18n/`),
- the translator facades exposed on the adapter as `adapter.i18nBackend` and `adapter.i18nCore`.

Conceptually:

1. `main.js` constructs the registry in `_i18ninit()` and adds two static sources: `core-runtime` and `root-admin-overlay`.
2. `_i18ninit()` calls `createTranslator()` twice to produce the frozen `i18nBackend` and `i18nCore` facades.
3. The registry is passed to `IoPlugins` as `options.i18nRegistry`.
4. On plugin register, `IoPlugins._loadPluginI18n()` validates plugin-owned keys and calls `addSource()`.
5. On plugin unregister, `IoPlugins` calls `removeSource()`.
6. All translator facades created at any point in time see source additions/removals immediately — no recreation needed.

---

## Responsibilities

`IoRuntimeI18n` is responsible for:

1. Accepting and storing named i18n sources with type-based priority (`addSource()`).
2. Replacing an existing source when a new one with the same ID is registered.
3. Removing sources by ID on demand (`removeSource()`).
4. Lazily materializing a merged word table (`words[key][lang]`) on the first `t()` call after any source change.
5. Logging a warning when a key-lang pair from a higher-priority source overwrites a non-identical value from a lower-priority source.
6. Providing closure-based translator facades that hold a live reference to the registry and require no recreation after source changes (`createTranslator()`).
7. Validating all inputs before mutating internal state — a throw in `addSource()` leaves the registry unchanged.

---

## Non-responsibilities

`IoRuntimeI18n` is explicitly **not** responsible for:

1. Loading i18n files from the filesystem.
   That belongs to `loadI18nDir()` (static sources, called by `main.js`) and `IoPlugins._loadPluginI18n()` (plugin-owned sources).
2. Enforcing plugin key namespace rules.
   `IoPlugins` validates that plugin-owned keys start with `msghub.i18n.<PluginTypeName>.` before calling `addSource()`.
   The registry receives already-filtered `wordsByLang` and applies no further namespace checks.
3. Storing or surfacing the locale or format-locale fields on the translator facade.
   `main.js` decorates the frozen `i18nBackend` / `i18nCore` objects with `locale` and `i18nlocale` after calling `createTranslator()`.
4. Owning the adapter-level `i18nBackend` / `i18nCore` references.
   Those are properties of the adapter object; the registry merely provides the translation logic.

---

## Public API / contract surface

### `new IoRuntimeI18n(options?)`

Creates the registry. The constructor is synchronous and performs no I/O.

Relevant options:

- `options.log` — optional `{ warn(msg) }` logger for key-collision warnings during materialization.

---

### Source management

### `addSource(id, type, wordsByLang)`

Registers or replaces an i18n source.

- `id` — unique source identifier, e.g. `'core-runtime'`, `'plugin:IngestStates:0'`.
- `type` — one of `'core-runtime'`, `'root-admin-overlay'`, `'plugin-runtime'`. Unknown type throws.
- `wordsByLang` — plain object mapping language code to key-translation map. Non-plain-object throws.

Validation is always completed before any state mutation.
If validation throws, the registry is left unchanged.
Invalidates the materialized cache.

### `removeSource(id)`

Removes a source by ID. No-op when the ID is not registered (safe to call on double-unregister or missing source). Invalidates the materialized cache only when a source was actually removed.

### `getSourceIds()`

Returns the registered source IDs in registration order. Intended for diagnostics and test assertions.

---

### Translation

### `createTranslator(lang)`

Returns a translator facade bound live to this registry:

```js
const { t, getTranslatedObject } = registry.createTranslator('en');
```

The facade holds a reference to the registry instance, not a snapshot of its state.
Sources added after `createTranslator()` is called are visible to the facade immediately — no recreation required (closure-binding, A8).

**`t(key, ...args)`**

- Resolves `key` in `lang`, falls back to `'en'`, falls back to returning the key string itself.
- Replaces `%s` placeholders with `args` in order. `null` arguments become the string `'null'`.

**`getTranslatedObject(key, ...args)`**

- Returns a plain object with translations for all available languages for `key`.
- Falls back to `{ en: key }` when `key` is unknown.
- Applies `%s` substitution to all languages when the `en` translation contains `%s`.

---

## Source priority model

Sources are merged in ascending priority order; a higher-priority source wins on key-lang collision:

| Type | Priority | Key scope |
|---|---|---|
| `core-runtime` | 0 (lowest) | `msghub.i18n.core.*` — loaded from `i18n/<lang>.json` |
| `root-admin-overlay` | 1 | All keys from `admin/i18n/` — loaded from `lib/_generated/backend-i18n/root-admin/<lang>.json` (ADR-C1: no regex filter; includes any key area declared in `admin/i18n/`, not only `.core.admin.*`) |
| `plugin-runtime` | 2 (highest) | `msghub.i18n.<PluginTypeName>.*` — namespace-guarded by `IoPlugins` before `addSource()` |

Because `plugin-runtime` sources are namespace-guarded, they contain only keys in the plugin's own namespace. In practice this means priority conflicts between layer 2 and layers 0/1 cannot occur — the priority order is only materially relevant between layers 0 and 1.

---

## Design notes / invariants

### 1. Validation before mutation

`addSource()` validates both `type` and `wordsByLang` before touching `_sources` or `_materialized`.
A throw means no partial state has been written.

### 2. Lazy materialization

`_materialized` is set to `null` on every `addSource()` or `removeSource()` that changes state.
The merged word table is rebuilt on the next `t()` or `getTranslatedObject()` call.
Sources are sorted by priority at materialization time, not at registration time.

### 3. Live closure-binding (A8)

`createTranslator()` returns closures that call `this._getMaterialized()` on every invocation.
This means the facade is a thin delegation layer, not a snapshot.
Adding a new source after creating a translator is immediately reflected in all existing facades.

### 4. Collision warnings are per-key-lang pair

When a higher-priority source overwrites a key-lang value that differs from the existing value, a single `log.warn()` is emitted per collision at materialization time.
Equal values from two sources do not produce a warning.

### 5. `removeSource()` is always safe

`removeSource()` with an unknown ID is a no-op. It does not throw. This makes it safe to call during plugin unregister even when the plugin had no i18n directory and `addSource()` was never called for it.

---

## Related files

- Implementation: `lib/IoRuntimeI18n.js`
- Static source loader: `lib/loadI18nDir.js`
- Registry construction: `main.js` (`_i18ninit()`)
- Plugin i18n lifecycle: `lib/IoPlugins.js` (`_loadPluginI18n()`, `_registerOne()`, `_unregisterOne()`)
- Tests: `main.test.js` (integration), `lib/IoPlugins.test.js` (lifecycle)
- IO overview: `docs/io/README.md`
