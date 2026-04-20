# IoSystemBaseline (Message Hub IO): MsgHub-owned system baseline for public web

`IoSystemBaseline` is the adapter-side owner of the MsgHub-managed reference baseline for public web.
It ensures the canonical user, group, descriptions, ACL, membership, icon, enabled flags, and password on every adapter start.

In short:

- `IoSystemBaseline` owns only the MsgHub-managed reference objects.
- `IoSystemBaseline` is strict about canonical correction for those objects.
- `IoSystemBaseline` does not take over productive `web.*` assignment from the admin.

---

## Why this file exists

Without `IoSystemBaseline`, system-object provisioning for the public-web reference setup would be scattered across `main.js` or ad-hoc helpers.
That causes:

- unclear ownership,
- weak testability,
- inconsistent correction behavior.

`IoSystemBaseline` centralizes this ioBroker-side baseline work in one class with a narrow, explicit scope.

---

## System role

Simple flow:

1. `main.js` creates `IoSystemBaseline` early during startup.
2. `main.js` calls `await ioSystemBaseline.ensure()`.
3. `IoSystemBaseline` ensures the canonical MsgHub-owned user and group baseline.
4. Startup continues even if that ensure step fails; `main.js` logs the failure as an error.

References:

- routing/composition root: `main.js`
- implementation: `lib/IoSystemBaseline.js`

---

## Responsibilities

`IoSystemBaseline` is responsible for:

1. Ensuring the canonical user `system.user.msghub_webapp_user`.
2. Ensuring the canonical group `system.group.msghub_web`.
3. Enforcing exact group membership to `['system.user.msghub_webapp_user']`.
4. Enforcing the canonical group ACL for the public-web baseline.
5. Enforcing canonical `common.desc`, `common.icon = '/adapter/msghub/msghub.png'`, and `common.enabled = true` on both objects.
6. Setting a fresh controller-managed password via `setPasswordAsync('msghub_webapp_user', generatedPassword)`.
7. Reading available `web.*` instances through the verified controller object-view path for the public-web scope.

---

## Non-responsibilities

`IoSystemBaseline` is explicitly **not** responsible for:

1. Mutating foreign admin-managed users or groups.
2. Writing `system.adapter.web.X.native.defaultUser`.
3. Owning Admin UI diagnostics or warning surfaces.
4. Normalizing adapter config through `MsgConfig`.
5. Importing or depending on core-layer internals.

Those responsibilities remain in `main.js`, Admin/UI layers, and config-normalization code.

---

## Authoritative baseline

### Canonical identities

- group id: `system.group.msghub_web`
- group display name: `MessageHub Web`
- group description: `Built-in MessageHub user group for web access.`
- user id: `system.user.msghub_webapp_user`
- user display name: `MessageHub WebApp User`
- user description: `Built-in MessageHub user for an ioBroker.web instance used by the WebApp.`
- icon: `/adapter/msghub/msghub.png`

### Canonical group ACL

- `file.{list,read,write,create,delete}` = all `false`
- `object.{list,read,write,create,delete}` = all `false`
- `users.{list,read,write,create,delete}` = all `false`
- `state.{list,read,write,create,delete}` = all `false`
- `other.execute = false`
- `other.http = true`
- `other.sendto = false`

### Canonical membership

- `common.members = ['system.user.msghub_webapp_user']`

### Password policy

- generated randomly
- exactly 16 characters
- contains upper, lower, digit, and safe special characters
- never logged
- never persisted in `native` or states
- always written through `setPasswordAsync(...)`

---

## Error semantics

`IoSystemBaseline.ensure()` propagates backend errors to the caller.
`main.js` is responsible for the startup policy:

- log the failure clearly as `error`
- continue adapter startup

This keeps the baseline strict for MsgHub-owned objects without turning it into a startup hard-stop for the whole adapter runtime.

---

## Guardrails

1. Scope guardrail: only MsgHub-owned reference objects are touched.
2. No automatic `web.*` config mutation.
3. Membership is canonical and exact, not additive.
4. Password handling stays controller-managed through `setPasswordAsync(...)`.
5. `web.defaultUser` comparisons use the short username `msghub_webapp_user`, not `system.user.msghub_webapp_user`.

---

## Test coverage (relevant files)

- `lib/IoSystemBaseline.test.js`
- `main.test.js`

Covered areas include:

- no-op object writes on an already-correct baseline
- missing user/group creation
- correction of name/description/icon/enabled drift
- hard reset of ACL and membership
- password generation and password-set path
- startup wiring and startup error handling in `main.js`
- verified `web.*` instance read path

---

## Related files

- implementation: `lib/IoSystemBaseline.js`
- tests: `lib/IoSystemBaseline.test.js`
- composition root: `main.js`
- IO API reference: `docs/io/API.md`
- IO overview: `docs/io/README.md`
