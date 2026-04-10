# IoAdminTab (Message Hub IO): admin runtime command facade (`admin.*`)

`IoAdminTab` is the adapter-side runtime/read facade for admin commands.
It handles only the `admin.*` namespace and maps those commands to runtime services (plugins and store).

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
4. Admin-host plugin UI RPC (`admin.pluginUi.rpc`) as a thin facade over the shared dispatcher `IoPluginUiRpc`.
5. Thin pass-through for `admin.ingestStates.presets.selectOptions*` (delegated to IngestStates runtime — no domain logic in IoAdminTab).
6. Canonical admin-token validation via `IoAdminCapabilities` before business execution.
7. Consistent response envelopes (`ok/data/error`) for admin runtime commands.

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

All normal `admin.*` commands require `payload.token` and validate it centrally via `IoAdminCapabilities` before execution.

- `admin.plugins.getCatalog`
- `admin.plugins.listInstances`
- `admin.plugins.createInstance`
- `admin.plugins.deleteInstance`
- `admin.plugins.updateInstance`
- `admin.plugins.setEnabled`

### Store/admin reads

- `admin.messages.delete`

### Plugin Admin UI host

- `admin.pluginUi.rpc` → `{ pluginType, instanceId, panelId, command, payload? }` → dispatches to the plugin's `handleAdminUiRpc` through `IoPluginUiRpc`

Not owned by `IoAdminTab` anymore:

- `web.pluginUi.bundle.get`
- `web.pluginUi.rpc`

### IngestStates selectOptions pass-through

- `admin.ingestStates.presets.selectOptions*` — thin pass-through only; delegated to `IngestStates.getPresetSelectOptions(...)`.
  Used by `admin/jsonCustom.json` (selectSendTo fields). No IoAdminTab-owned domain logic.
  This is the only documented backend exception that does not require `payload.token`; if a token is supplied, IoAdminTab may still validate and strip it.

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
- Missing or invalid `payload.token` on normal `admin.*` commands returns `FORBIDDEN` before business execution.

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
2. Token validation is centralized in `IoAdminCapabilities`; IoAdminTab does not implement local token logic.
3. Select options are read-only and never write runtime/native state.

---

## Test coverage (relevant files)

- `lib/IoAdminTab.test.js`

Covered areas include:

- plugin UI RPC routing (`admin.pluginUi.rpc` command dispatch via `IoPluginUiRpc`)
- token-required backend gating for normal `admin.*` commands
- rejection of migrated web-safe commands on `admin.*`
- rejection of removed `admin.pluginUi.discover` / `admin.pluginUi.bundle.get`
- rejection of config-scope commands on admin scope
- `admin.ingestStates.presets.selectOptions*` pass-through behavior, including the documented token exception
- `admin.messages.delete`

---

## Related files

- implementation: `lib/IoAdminTab.js`
- tests: `lib/IoAdminTab.test.js`
- routing: `main.js`
- config counterpart: `lib/IoAdminConfig.js` / `docs/io/IoAdminConfig.md`
- IO overview: `docs/io/README.md`
