# IoAdminTab (Message Hub IO): admin runtime command facade (`admin.*`)

`IoAdminTab` is the adapter-side runtime/read facade for admin commands.
It handles only the `admin.*` namespace and maps those commands to runtime services (plugins, store, plugin UI host).

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
3. Store-backed admin delete flow (`admin.messages.delete`).
4. Plugin Admin UI host commands (`admin.pluginUi.discover`, `admin.pluginUi.bundle.get`, `admin.pluginUi.rpc`).
5. Thin pass-through for `admin.ingestStates.presets.selectOptions*` (delegated to IngestStates runtime — no domain logic in IoAdminTab).
6. Consistent response envelopes (`ok/data/error`) for admin runtime commands.

---

## Non-responsibilities

`IoAdminTab` is explicitly **not** responsible for:

1. Config command path (`config.*`) and `useNative` patch responses.
2. Archive strategy lock commands (`config.archive.*`).
3. AI config test command (`config.ai.test`).
4. Startup archive strategy resolution (`IoArchiveResolver`).
5. IngestStates-specific domain logic for presets, bulk-apply, schema, custom, or constants — all moved to plugin-owned bundles and the IngestStates runtime.

Those responsibilities belong to `IoAdminConfig`, resolver/startup wiring, and the plugin-owned Admin UI layer.

---

## Authoritative command contract (`admin.*`)

### Plugin runtime

- `admin.plugins.getCatalog`
- `admin.plugins.listInstances`
- `admin.plugins.createInstance`
- `admin.plugins.deleteInstance`
- `admin.plugins.updateInstance`
- `admin.plugins.setEnabled`

### Store/admin reads

- `admin.messages.delete`

### Plugin Admin UI host

- `admin.pluginUi.discover` → `{ lang? }` → discovers all Admin UI contributions from running plugins and enriches them with computed bundle hashes plus plugin-owned Admin-UI i18n for the requested shell language
- `admin.pluginUi.bundle.get` → `{ pluginType, instanceId, panelId, lang }` → `{ apiVersion, moduleFormat, hash, js, css?, i18n|null }`
- `admin.pluginUi.rpc` → `{ pluginType, instanceId, panelId, command, payload? }` → dispatches to plugin's `handleAdminUiRpc`

### IngestStates selectOptions pass-through

- `admin.ingestStates.presets.selectOptions*` — thin pass-through only; delegated to `IngestStates.getPresetSelectOptions(...)`.
  Used by `admin/jsonCustom.json` (selectSendTo fields). No IoAdminTab-owned domain logic.

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

- `admin.ingestStates.presets.selectOptions*` returns an array (`[{ value, label }, ...]`) without an `ok` envelope — required by `jsonCustom` selectSendTo contract.

Typical error codes:

- `BAD_REQUEST` (missing/invalid input)
- `NOT_READY` (runtime/plugin wiring unavailable)
- `NOT_FOUND`
- `INTERNAL`
- `TIMEOUT`
- `REJECTED`
- `UNKNOWN_COMMAND`
- `FORBIDDEN`

Discover DTO shape:

- `{ pluginType, instanceId, panelId, label, description, category?, app?, apiVersion, bundle: { hash }, i18n?: { lang, translations }|null }`
- `label` is the plugin-owned admin-ui i18n key for the panel/tab label
- `i18n`, when present, already carries the plugin-owned Admin-UI translations for the requested shell language and is consumed by the shell before first plugin-panel mount
- `app`, when present, is forwarded from the plugin manifest for text/url/display metadata; the current AdminTab installability/head path resolves plugin panel icons from the generic host set `admin/icons/pluginUI/*`

---

## Guardrails

1. Scope guardrail: `admin.*` only; no config mutation semantics.
2. Select options are read-only and never write runtime/native state.

---

## Test coverage (relevant files)

- `lib/IoAdminTab.test.js`

Covered areas include:

- plugin UI RPC routing (`admin.pluginUi.*` command dispatch)
- rejection of migrated web-safe commands on `admin.*`
- rejection of config-scope commands on admin scope
- `admin.ingestStates.presets.selectOptions*` pass-through behavior (delegation to IngestStates runtime)
- `admin.messages.delete`

---

## Related files

- implementation: `lib/IoAdminTab.js`
- tests: `lib/IoAdminTab.test.js`
- routing: `main.js`
- config counterpart: `lib/IoAdminConfig.js` / `docs/io/IoAdminConfig.md`
- IO overview: `docs/io/README.md`
