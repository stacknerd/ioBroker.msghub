# IoWebUi (Message Hub IO): web-safe runtime command facade (`web.*`)

`IoWebUi` is the adapter-side runtime/read facade for web-safe commands.
It handles only the `web.*` namespace.

In short:

- `IoWebUi` is the web-safe backend facade parallel to `IoAdminTab`.
- `IoWebUi` is **not** responsible for WebExtension mount/routing/asset serving.
- `IoWebUi` is the backend command owner for `web.*`.

---

## Why this file exists

Without `IoWebUi`, the web-safe runtime commands would remain mixed into admin-only backend ownership.
That would keep the public/web-safe command surface coupled to `IoAdminTab`, which conflicts with the package-15 architecture cut.

`IoWebUi` centralizes the migrated web-safe runtime commands in one facade with stable response shapes and clear scope boundaries.

---

## System role

Simple flow for this package:

1. A host-facing backend caller sends `web.*`.
2. `main.js` routes that command to `_handleWebCommand(...)`.
3. `_handleWebCommand(...)` delegates to `IoWebUi.handleCommand(...)`.
4. `IoWebUi` executes the runtime operation and returns a normalized response.

## Responsibilities

`IoWebUi` is responsible for:

1. Web-safe command routing for the `web.*` namespace.
2. Store-backed web-safe reads and actions:
   - `web.constants.get`
   - `web.messages.query`
   - `web.messages.action`
   - `web.view.get`
   - `web.ping`
3. Canonical web-token validation via `IoAdminCapabilities` before business execution.
4. Shared-safe plugin UI backend commands:
   - `web.pluginUi.bundle.get`
   - `web.pluginUi.rpc`
5. Consistent response envelopes (`ok/data/error`) for the web-safe runtime commands.

---

## Non-responsibilities

`IoWebUi` is explicitly **not** responsible for:

1. Admin-only command handling (`admin.*`).
2. Config command handling (`config.*`).
3. Neutral bootstrap handling (`ui.bootstrap`).
4. Admin-host-only plugin UI RPC (`admin.pluginUi.rpc`).
5. Express/WebExtension mount handling.
6. Static asset, manifest, or icon serving.
7. Host-specific route resolution or HTML serving.

Those responsibilities remain outside this facade in AP4.

---

## Authoritative command contract

All `web.*` commands require `payload.token` and validate it centrally via `IoAdminCapabilities` before execution.

- `web.ping`
- `web.constants.get`
- `web.messages.query`
- `web.messages.action`
- `web.view.get`
- `web.pluginUi.bundle.get`
- `web.pluginUi.rpc`

---

## Response and error semantics

Default responses:

- success: `{ ok: true, data: ... }`
- error: `{ ok: false, error: { code, message } }`

Typical error codes:

- `BAD_REQUEST`
- `NOT_READY`
- `INTERNAL`
- `REJECTED`
- `UNKNOWN_COMMAND`
- `FORBIDDEN`

Behavior notes:

- `web.messages.query` passes through only `query.where`, `query.page`, and `query.sort`, serializes maps to JSON-safe objects, and attaches `meta.generatedAt` and local `tz`.
- `web.messages.action` requires `ref` and `actionId` and returns `REJECTED` when the executor returns false.
- `web.constants.get` returns only `kind`, `lifecycle.state`, `level`, and `notfication.events`.
- `web.ping` always returns `{ ok: true, data: 'pong' }`.
- `web.view.get` delegates view normalization, wildcard materialization, and `pluginPanels` assembly to `IoUiCatalog`.
- `web.pluginUi.bundle.get` validates target panels through the canonical backend resolver, normalizes bundle language and the optional `include` / `exclude` projection locally, then reads bundle files from `IoPlugins`.
- `web.pluginUi.bundle.get` keeps the bundle hash shared across full and partial responses; cache identity therefore includes the normalized projection in addition to `(pluginType, instanceId, panelId, hash, lang)`.
- `web.pluginUi.rpc` delegates host-bound RPC validation and dispatch to `IoPluginUiRpc`, which resolves the target through the same canonical backend resolver before calling `handleWebUiRpc`.

---

## Guardrails

1. Scope guardrail: `web.*` only.
2. Token validation is centralized in `IoAdminCapabilities`; IoWebUi does not implement local token logic.
3. No WebExtension mount/routing/asset logic.
4. No second plugin-panel lookup path beside the canonical backend resolver.

---

## Test coverage (relevant files)

- `lib/IoWebUi.test.js`
- `main.test.js`

Covered areas include:

- `web.*` command dispatch
- token-required backend gating for `web.*`
- store-backed query/action/constants behavior
- plugin UI bundle/RPC behavior
- unknown-command rejection

---

## Related files

- implementation: `lib/IoWebUi.js`
- tests: `lib/IoWebUi.test.js`
- canonical panel resolver: `lib/IoPluginPanelResolver.js`
- routing: `main.js`
- admin counterpart: `lib/IoAdminTab.js` / `docs/io/IoAdminTab.md`
- IO overview: `docs/io/README.md`
