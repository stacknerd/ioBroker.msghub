# IoPluginUiRpc (Message Hub IO): shared PluginUi RPC dispatcher

`IoPluginUiRpc` is the adapter-side shared validation and dispatch facade for host-bound PluginUi RPC.
It does not own a command namespace itself.

In short:

- `IoPluginUiRpc` centralizes the shared RPC core used by `IoAdminTab` and `IoWebUi`.
- `IoPluginUiRpc` is **not** responsible for `discover` or `bundle.get`.
- `IoPluginUiRpc` keeps the public plugin hook split explicit:
  - `handleAdminUiRpc`
  - `handleWebUiRpc`

---

## Why this file exists

Without `IoPluginUiRpc`, host-bound PluginUi RPC handling would be duplicated in `IoAdminTab` and `IoWebUi`.
That causes:

- duplicated validation logic,
- duplicated panel lookup and timeout handling,
- higher drift risk between admin and web RPC behavior.

`IoPluginUiRpc` centralizes that shared RPC core in one file while preserving the explicit public hook split required by the contract.

---

## System role

Simple flow:

1. A host-facing backend caller sends either `admin.pluginUi.rpc` or `web.pluginUi.rpc`.
2. `IoAdminTab` or `IoWebUi` routes that command into `IoPluginUiRpc`.
3. `IoPluginUiRpc` validates the host-bound payload and resolves the active plugin panel through the canonical backend resolver.
4. `IoPluginUiRpc` dispatches to the host-specific plugin hook and returns a normalized response.

References:

- admin facade: `lib/IoAdminTab.js`
- web facade: `lib/IoWebUi.js`
- implementation: `lib/IoPluginUiRpc.js`

---

## Responsibilities

`IoPluginUiRpc` is responsible for:

1. Shared validation for host-bound PluginUi RPC payloads.
2. Payload-size enforcement for PluginUi RPC (`64 KiB` serialized limit).
3. Active plugin-panel lookup for `{ pluginType, instanceId, panelId }` through `IoPluginPanelResolver`.
4. Host-bound dispatch to:
   - `handleAdminUiRpc`
   - `handleWebUiRpc`
5. Shared timeout and response-shape guardrails for both RPC paths.

---

## Non-responsibilities

`IoPluginUiRpc` is explicitly **not** responsible for:

1. `discover` command ownership.
2. `bundle.get` command ownership.
3. `main.js` routing.
4. WebExtension mount, route, HTML, manifest, icon, or asset handling.
5. Bootstrap/capability/token ownership.

Those responsibilities belong to `IoAdminTab`, `IoWebUi`, `main.js`, and the later host-side WebExtension layer.

---

## Authoritative entry points

### Shared dispatcher

- `new IoPluginUiRpc(adapter, ioPlugins)`
- `handleAdminRpc(payload)` — validates and dispatches to `handleAdminUiRpc`
- `handleWebRpc(payload)` — validates and dispatches to `handleWebUiRpc`

### Payload contract

- `{ pluginType, instanceId, panelId, command, payload? }`

The payload is host-bound:

- plugin identity is validated against the canonical runtime resolver
- the caller does not get a second hidden path to override runtime identity

---

## Response and error semantics

Default responses:

- success: `{ ok: true, data: ... }`
- error: `{ ok: false, error: { code, message } }`

Typical error codes:

- `BAD_REQUEST`
- `NOT_READY`
- `NOT_FOUND`
- `TIMEOUT`
- `INTERNAL`

Dispatch behavior:

- `handleAdminRpc(...)` dispatches to `plugin.handleAdminUiRpc(...)`
- `handleWebRpc(...)` dispatches to `plugin.handleWebUiRpc(...)`
- a shared internal plugin dispatcher is allowed, but it does not replace the explicit public hook split

---

## Guardrails

1. Scope guardrail: shared PluginUi RPC core only; no command-namespace ownership.
2. No `discover` / `bundle.get` ownership.
3. No hidden admin-to-web or web-to-admin bridge semantics.
4. Host split stays explicit even when plugins internally reuse the same dispatcher.

---

## Test coverage (relevant files)

- `lib/IoPluginUiRpc.test.js`

Covered areas include:

- admin/web hook selection
- required-field validation
- payload-size validation
- missing panel/runtime handling
- timeout handling
- unexpected plugin response handling

---

## Related files

- implementation: `lib/IoPluginUiRpc.js`
- tests: `lib/IoPluginUiRpc.test.js`
- canonical panel resolver: `lib/IoPluginPanelResolver.js`
- admin facade: `lib/IoAdminTab.js`
- web facade: `lib/IoWebUi.js`
- IO overview: `docs/io/README.md`
