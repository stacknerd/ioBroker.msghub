# IoCoreConnection (Message Hub IO): official core-link connection state owner

`IoCoreConnection` is the platform-side owner of the official adapter state
`msghub.<instance>.info.connection`.

It encapsulates the ioBroker-facing connection semantics between the adapter/runtime layer
and the effective MsgHub core link.

In short:

- `IoCoreConnection` is **not** an AdminTab socket status helper.
- `IoCoreConnection` is the single IO/platform truth source for the core-link state in
  the current local-core implementation.

---

## Why this file exists

Without `IoCoreConnection`, responsibility for the official adapter connection state would
stay spread across `main.js` and ad hoc startup logic.

That would cause:

- unclear ownership of `info.connection`,
- mixed semantics between UI transport and backend/core health,
- weaker alignment with the platform/runtime/core split from the architecture roadmap.

`IoCoreConnection` centralizes this platform concern in one dedicated IO module.

---

## System role

Simple flow:

1. `main.js` creates `IoCoreConnection`.
2. `IoCoreConnection.init()` ensures the official state object exists and marks it
   disconnected.
3. After `MsgStore.init()`, `main.js` asks `IoCoreConnection.checkHealthLocal(...)` for a
   small local health snapshot.
4. `IoCoreConnection.markFromHealth(...)` writes `info.connection` and updates the
   `runtime.about.connection` view.
5. On unload, `IoCoreConnection.markDisconnected()` writes `false` best effort.

References:

- implementation: `lib/IoCoreConnection.js`
- adapter wiring: `main.js`

---

## Responsibilities

`IoCoreConnection` is responsible for:

1. Owning the official adapter state `info.connection`.
2. Ensuring the state object contract is present (`boolean`, `indicator.connected`,
   `read: true`, `write: false`).
3. Providing the small platform-side health contract for the effective core link.
4. Exposing the minimal `runtime.about.connection` payload used by the AdminTab.
5. Keeping `info.connection` semantically separate from UI/socket transport status.

---

## Non-responsibilities

`IoCoreConnection` is explicitly **not** responsible for:

1. AdminTab socket/ping status (`Browser/AdminTab <-> Adapter`).
2. Aggregating plugin, cloud, or fremdsystem connection states.
3. Defining a remote-core transport protocol.
4. Exposing optional diagnostic states such as latency, last-seen, or error-reason.

Those topics are intentionally outside the current package scope.

---

## State and payload contract

Official adapter state:

- id: `msghub.<instance>.info.connection`
- type: `boolean`
- role: `indicator.connected`
- meaning:
  - `true`: platform/runtime considers the effective core link available
  - `false`: platform/runtime considers the effective core link unavailable or not ready

Minimal `runtime.about.connection` payload:

```js
{
  scope: 'core-link',
  connected: true|false,
  mode: 'local'
}
```

This payload mirrors the same backend truth as `info.connection`, but is shaped for
AdminTab consumption.

---

## Local health model

The current implementation intentionally uses a small direct local health check instead of simulating a
transport-style ping/pong inside the same process.

Current local probe checks for expected `MsgStore` runtime capabilities, for example:

- `getMessages()`
- `addMessage()`
- `msgIngest.start()`
- `msgNotify`

This preserves the architectural idea of a stable core-link health contract without
introducing premature remote-transport complexity.

---

## Roadmap note

The semantic contract is intended to stay stable when a remote core exists later:

- today: local in-process core link
- later: remote/external core link

Only the technical health probe should change later. The meaning of
`info.connection` should not.

---

## Test coverage (relevant files)

- `lib/IoCoreConnection.test.js`
- `admin/tab/boot.test.js` (consumer-side rendering of `runtime.about.connection`)

Covered areas include:

- state object contract
- disconnected/connected state writes
- local health snapshot behavior
- AdminTab separation of UI connection vs. core connection

---

## Related files

- implementation: `lib/IoCoreConnection.js`
- tests: `lib/IoCoreConnection.test.js`
- adapter wiring: `main.js`
- AdminTab consumer: `admin/tab/boot.js`
- IO overview: `docs/io/README.md`
