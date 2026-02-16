# IoAdminTab (Message Hub IO): admin runtime command facade (`admin.*`)

`IoAdminTab` is the adapter-side runtime/read facade for admin commands.
It handles only the `admin.*` namespace and maps those commands to runtime services (plugins, store, preset read APIs).

In short:

- `IoAdminTab` is **not** responsible for config mutations.
- `IoAdminTab` is the central runtime API for `sendTo(..., 'admin.*', ...)`.

---

## Why this file exists

Without `IoAdminTab`, admin-specific command flows would be scattered across `main.js`, plugin wiring, and store helpers.
That causes:

- unclear ownership,
- unstable command contracts,
- poor testability.

`IoAdminTab` centralizes those runtime commands in one file with stable response shapes and clear error semantics.

---

## System role

Simple flow:

1. ioBroker sends `sendTo(..., command='admin.*', payload)`.
2. `main.js` routes to `_handleAdminCommand(...)`.
3. `_handleAdminCommand(...)` delegates to `IoAdminTab.handleCommand(...)`.
4. `IoAdminTab` executes the runtime operation and returns a normalized response.

References:

- routing: `main.js` (`_handleAdminCommand`)
- implementation: `lib/IoAdminTab.js`

---

## Responsibilities

`IoAdminTab` is responsible for:

1. Admin command routing for the `admin.*` namespace.
2. Runtime read/write calls for plugin instances (`admin.plugins.*`).
3. Store-backed admin reads (`admin.stats.get`, `admin.messages.query`, `admin.messages.delete`).
4. IngestStates admin APIs (`custom/schema/constants/bulkApply/presets`).
5. Read-only preset options for jsonCustom via `admin.ingestStates.presets.selectOptions*`.
6. Consistent response envelopes (`ok/data/error`) for admin runtime commands.

---

## Non-responsibilities

`IoAdminTab` is explicitly **not** responsible for:

1. Config command path (`config.*`) and `useNative` patch responses.
2. Archive strategy lock commands (`config.archive.*`).
3. AI config test command (`config.ai.test`).
4. Startup archive strategy resolution (`IoArchiveResolver`).

Those responsibilities belong to `IoAdminConfig` and resolver/startup wiring.

---

## Authoritative command contract (`admin.*`)

The following commands are compatible and active:

### Plugin runtime

- `admin.plugins.getCatalog`
- `admin.plugins.listInstances`
- `admin.plugins.createInstance`
- `admin.plugins.deleteInstance`
- `admin.plugins.updateInstance`
- `admin.plugins.setEnabled`

### Store/admin reads

- `admin.stats.get`
- `admin.messages.query`
- `admin.messages.delete`
- `admin.constants.get`

### IngestStates runtime/admin APIs

- `admin.ingestStates.custom.read`
- `admin.ingestStates.schema.get`
- `admin.ingestStates.constants.get`
- `admin.ingestStates.bulkApply.preview`
- `admin.ingestStates.bulkApply.apply`
- `admin.ingestStates.presets.list`
- `admin.ingestStates.presets.selectOptions*` (read-only option extraction)
- `admin.ingestStates.presets.get`
- `admin.ingestStates.presets.upsert`
- `admin.ingestStates.presets.delete`

Intentionally incompatible:

- `admin.archive.*`
- `admin.ai.test`

These must use `config.*`.

---

## Response and error semantics

Default responses for runtime commands:

- success: `{ ok: true, data: ... }`
- error: `{ ok: false, error: { code, message } }`

Special case:

- `admin.ingestStates.presets.selectOptions*` returns an array (`[{ value, label }, ...]`) for jsonCustom.

Typical error codes:

- `BAD_REQUEST` (missing/invalid input)
- `NOT_READY` (runtime/plugin wiring unavailable)
- `PLUGIN_NOT_FOUND` / `PLUGIN_DISABLED`
- `UNKNOWN_COMMAND`
- `FORBIDDEN` (for example owner-protected presets)

---

## Guardrails

1. Scope guardrail: `admin.*` only; no config mutation semantics.
2. Preset guardrail: owner-protected presets cannot be deleted/overwritten.
3. Bulk-apply sanitizing: no dot keys or nested object leaks in custom apply paths.
4. Select options are read-only and never write runtime/native state.

---

## Test coverage (relevant files)

- `lib/IoAdminTab.test.js`

Covered areas include:

- bulk-apply sanitizing
- rejection of config-scope commands on admin scope
- preset list/filter/sort
- preset CRUD guardrails
- `admin.ingestStates.presets.selectOptions*` response behavior

---

## Related files

- implementation: `lib/IoAdminTab.js`
- tests: `lib/IoAdminTab.test.js`
- routing: `main.js`
- config counterpart: `lib/IoAdminConfig.js` / `docs/io/IoAdminConfig.md`
- IO overview: `docs/io/README.md`
