# IoAdminCapabilities (Message Hub IO): bootstrap/about contract authority

`IoAdminCapabilities` is the adapter-side bootstrap/about facade for host-facing UI entry points.
It centralizes the stable backend shape for `ui.bootstrap` and the shared `about` payload currently reused by legacy `runtime.about`.

In short:

- `IoAdminCapabilities` is the single authority for bootstrap shape on the IO side.
- `IoAdminCapabilities` is intentionally host-aware (`admin`, `webExtension`), but it does not own host routing or mounting.
- `IoAdminCapabilities` does **not** introduce token issuance, TTL, expiry, or command gates in AP3.

---

## Why this file exists

Without `IoAdminCapabilities`, bootstrap and host-capability logic would be assembled inline in `main.js` and later repeated in additional host entry points.
That causes:

- unclear ownership,
- drifting bootstrap response shapes,
- poor testability for host-specific bootstrap behavior.

`IoAdminCapabilities` centralizes that logic in one runtime file with a stable response contract and a narrow responsibility.

---

## System role

Simple flow for the current AP3 admin-host path:

1. ioBroker sends `sendTo(..., command='ui.bootstrap', payload)`.
2. `main.js` recognizes the neutral bootstrap command.
3. `main.js` delegates to `IoAdminCapabilities.buildBootstrap({ host: 'admin' })`.
4. `IoAdminCapabilities` returns the stable payload `{ capabilities, about }`.

For the legacy/shared `runtime.about` path:

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
3. Normalizing the supported host classes `admin` and `webExtension`.
4. Keeping bootstrap/capability shape out of `main.js` inline routing code.

---

## Non-responsibilities

`IoAdminCapabilities` is explicitly **not** responsible for:

1. Routing ioBroker messagebox commands.
2. Handling `admin.*` runtime commands.
3. Handling `config.*` commands.
4. Web host mount logic, routing, manifest serving, icon serving, or asset serving.
5. Token issuance, TTL, expiry, namespace gates, or command authorization in AP3.

Those responsibilities belong to `main.js`, `IoAdminTab`, `IoAdminConfig`, and later host-specific web components.

---

## Authoritative contract

### `ui.bootstrap`

Input:

- current AP3 admin-host usage requires no payload fields

Output:

- `{ ok: true, data: { capabilities, about } }`

Rules in AP3:

- `capabilities` is mandatory
- `capabilities` is intentionally `{}` in this package
- `about` carries the runtime metadata payload previously exposed via `runtime.about`

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
3. AP3 keeps `capabilities` empty; no token or gate semantics may be smuggled into this file.

---

## Test coverage (relevant files)

- `lib/IoAdminCapabilities.test.js`
- `main.test.js`

Covered areas include:

- stable AP3 bootstrap shape
- supported host normalization
- rejection of unsupported host classes
- `main.js` delegation for `ui.bootstrap`
- `main.js` reuse of the shared `about` payload for `runtime.about`

---

## Related files

- implementation: `lib/IoAdminCapabilities.js`
- tests: `lib/IoAdminCapabilities.test.js`
- routing: `main.js`
- admin runtime counterpart: `lib/IoAdminTab.js` / `docs/io/IoAdminTab.md`
- config counterpart: `lib/IoAdminConfig.js` / `docs/io/IoAdminConfig.md`
- IO overview: `docs/io/README.md`
