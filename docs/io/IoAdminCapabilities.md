# IoAdminCapabilities (Message Hub IO): bootstrap and capability-token authority

`IoAdminCapabilities` is the adapter-side bootstrap and token-authority facade for host-facing UI entry points.
It owns the stable backend shape for `ui.bootstrap`, the shared `about` payload currently reused by legacy `runtime.about`, and the canonical token contract for privileged namespaces.

In short:

- `IoAdminCapabilities` is the single authority for bootstrap shape and capability tokens on the IO side.
- `IoAdminCapabilities` is intentionally host-aware (`admin`, `webExtension`), but it does not own host routing or mounting.
- `IoAdminCapabilities` owns token issuance, validation, TTL/expiry, and canonical `payload.token` consumption.

---

## Why this file exists

Without `IoAdminCapabilities`, bootstrap and token logic would be assembled inline in `main.js` and later repeated in additional host entry points.
That causes:

- unclear ownership,
- drifting bootstrap and token contracts,
- poor testability.

`IoAdminCapabilities` centralizes that logic in one runtime file with stable contracts and a narrow responsibility.

---

## System role

Simple flow:

1. ioBroker sends `sendTo(..., command='ui.bootstrap', payload)`.
2. `main.js` recognizes the neutral bootstrap command.
3. `main.js` delegates to `IoAdminCapabilities.buildBootstrap({ host: 'admin' })`.
4. `IoAdminCapabilities` returns the stable payload `{ capabilities, about }`.

Legacy/shared about flow:

1. ioBroker sends `sendTo(..., command='runtime.about', payload)`.
2. `main.js` delegates the payload build to `IoAdminCapabilities.buildAbout()`.
3. The old command keeps its payload shape, but no longer owns the bootstrap target contract.

References:

- routing: `main.js`
- implementation: `lib/IoAdminCapabilities.js`

---

## Responsibilities

`IoAdminCapabilities` is responsible for:

1. Building the stable backend payload for `ui.bootstrap`.
2. Building the shared `about` payload `{ title, version, time, lang, connection }`.
3. Minting host- and capability-bound tokens with a `2h` TTL.
4. Validating tokens against host, capability, and expiry.
5. Enforcing the canonical `payload.token` contract and stripping `token` from the business payload.
6. Normalizing the supported host classes `admin` and `webExtension`.

---

## Non-responsibilities

`IoAdminCapabilities` is explicitly **not** responsible for:

1. Routing ioBroker messagebox commands.
2. Handling `admin.*` runtime commands.
3. Handling `config.*` commands.
4. Handling `web.*` runtime commands.
5. Web host mount logic, routing, manifest serving, icon serving, or asset serving.
6. Command routing/dispatch knowledge for concrete backend commands.

Those responsibilities belong to `main.js`, `IoAdminTab`, `IoAdminConfig`, and later host-specific web components.

---

## Authoritative contract (`ui.bootstrap` + token authority)

### `ui.bootstrap`

Input:

- no payload fields are required

Output:

- `{ ok: true, data: { capabilities, about } }`

Capability grants:

- admin host:
  - `capabilities.admin = { token, expiresAt }`
  - `capabilities.config = { token, expiresAt }`
  - `capabilities.web = { token, expiresAt }`
- `webExtension` host:
  - `capabilities.web = { token, expiresAt }`
- each token has a fixed `2h` TTL
- `about` carries the runtime metadata payload previously exposed via `runtime.about`

### Canonical payload token contract

For privileged namespaces the canonical transport is always the payload field `token`:

- `admin.*` requires `payload.token`
- `config.*` requires `payload.token`
- `web.*` requires `payload.token`

`IoAdminCapabilities.consumePayloadToken({ host, capability, payload })`:

1. reads `payload.token`
2. validates it against host/capability/expiry
3. removes `token` from the payload
4. returns only the cleaned business payload

Documented backend exception:

- `admin.ingestStates.presets.selectOptions*` is the single documented backend exception and may remain reachable without a token for external `jsonCustom` consumers.
- If that command still carries a token, later callers may either validate or ignore it.
- The exception is documented here, but `IoAdminCapabilities` itself does not embed command-specific routing knowledge.

### `about`

`buildAbout()` returns:

- `title`
- `version`
- `time`
- `lang`
- `connection`

This is the shared payload used by:

- `ui.bootstrap.data.about`
- legacy `runtime.about`

---

## Guardrails

1. `IoAdminCapabilities` owns bootstrap/about shape, not command routing.
2. Host awareness is limited to host-class normalization (`admin`, `webExtension`), not host implementation details.
3. Token authority stays self-contained in this class; no routing/dispatch knowledge may be smuggled into it.

---

## Test coverage (relevant files)

- `lib/IoAdminCapabilities.test.js`
- `main.test.js`

Covered areas include:

- host-specific bootstrap capability grants
- token minting with `2h` TTL
- host/capability validation
- canonical `payload.token` consumption
- rejection of unsupported host classes

---

## Related files

- implementation: `lib/IoAdminCapabilities.js`
- tests: `lib/IoAdminCapabilities.test.js`
- routing: `main.js`
- admin runtime counterpart: `lib/IoAdminTab.js` / `docs/io/IoAdminTab.md`
- config counterpart: `lib/IoAdminConfig.js` / `docs/io/IoAdminConfig.md`
- IO overview: `docs/io/README.md`
