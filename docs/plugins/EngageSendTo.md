# Engage: EngageSendTo (control plane via `sendTo` / messagebox)

`EngageSendTo` is the Message Hub **control plane** exposed via ioBroker `sendTo()` (messagebox).

It lets you create, patch, remove, and query messages from scripts (JavaScript/Blockly) **without** direct access to internal classes (`MsgStore`, `MsgFactory`, `MsgAction`).

Design goal: the control plane is implemented as an **Engage plugin** and is started/stopped by `IoPlugins` like any other plugin (enable switch + options stored in ioBroker objects).

---

## Basics

- Type: `Engage`
- Registration ID: `EngageSendTo:0`
- Implementation: `lib/EngageSendTo/index.js` (`EngageSendTo(options)`)
- Purpose: inbound `sendTo` commands → store mutations / queries / action execution

---

## Quick start (JavaScript)

Examples (e.g. in `javascript.0`):

```js
// List messages
sendTo('msghub.0', 'list', {}, res => {
  console.log(JSON.stringify(res, null, 2));
});

// Create a message
sendTo('msghub.0', 'create', {
  ref: 'demo:task:1',
  kind: 'task',
  level: 10, // notice
  title: 'Laundry',
  text: 'Empty the washing machine',
  origin: { type: 'manual', system: 'javascript.0', id: 'demo' },
}, res => console.log(JSON.stringify(res, null, 2)));
```

`sendTo` always uses the same shape:

- `sendTo('<adapterInstance>', '<command>', <payload>, callback)`
- `command` is one of the commands documented below (case-sensitive)
- `payload` becomes `obj.message` inside the adapter
- `callback` receives `{ ok, data | error }`

---

## Quick start (Blockly)

In Blockly, use a `sendTo` block:

- Instance: `msghub.0`
- Command: `list` / `create` / `patch` / `action` / …
- Message: object or JSON string (depends on your block variant)

Practical pattern:

1. Use the callback variant.
2. Check `response.ok`.
3. Use `response.data` on success, otherwise log `response.error`.

---

## Enable / disable (plugin runtime)

`EngageSendTo` is managed by `IoPlugins`:

- Enable switch: `msghub.0.EngageSendTo.0.enable`
- Status: `msghub.0.EngageSendTo.0.status`

If disabled or not started, `sendTo(...)` returns:

```js
{ ok: false, error: { code: 'NOT_READY', message: '...' } }
```

Note: there are currently no user-facing plugin options (`defaultOptions: {}`).

---

## Response format (all commands)

Success:

```js
{ ok: true, data: ... }
```

Error:

```js
{
  ok: false,
  error: {
    code: 'BAD_REQUEST' | 'NOT_READY' | 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION_FAILED' | 'UNKNOWN_COMMAND' | 'INTERNAL',
    message: '...',
    details?: any
  }
}
```

---

## Data conventions

### `ref`

- `ref` uniquely identifies a message.
- `create`/`upsert` may normalize `ref` (URL-safe encoding).
- Best practice: always use the returned `ref` for follow-up calls.

### `kind` and `level`

Current values are defined in `src/MsgConstants.js`:

- kinds: `task`, `status`, `appointment`, `shoppinglist`, `inventorylist`
- levels: `0` (none), `10` (notice), `20` (warning), `30` (error)

### Map encoding (`metrics`)

Responses are JSON-safe. If internal data contains `Map` values (for example `message.metrics`), they are encoded like:

```js
{ "__msghubType": "Map", "value": [["k", {"val":1,"unit":"x","ts":1}]] }
```

---

## Command reference

### `create`

Creates a new message.

Request payload (minimal):

```js
{
  ref: 'demo:task:1', // optional, but recommended
  kind: 'task',       // required
  level: 10,          // required
  title: 'Title',     // required
  text: 'Text',       // required
  origin: { type: 'manual', system: 'javascript.0', id: 'demo' } // required
}
```

Response `data`:

```js
{ ref: string, message: object }
```

Errors:

- `BAD_REQUEST`: payload is not an object
- `VALIDATION_FAILED`: invalid message payload
- `CONFLICT`: message could not be added (duplicate `ref` after normalization)

---

### `patch`

Patches an existing message by `ref`.

Request payload:

- Variant A (recommended):

```js
{ ref: 'demo:task:1', patch: { title: 'New title' } }
```

- Variant B (short form): everything except control keys is treated as a patch

```js
{ ref: 'demo:task:1', title: 'New title' }
```

Response `data`:

```js
{ ref: string, message: object }
```

Errors:

- `BAD_REQUEST`: payload is missing / not an object / `ref` missing
- `NOT_FOUND`: message does not exist
- `VALIDATION_FAILED`: patch rejected by store/factory

---

### `upsert`

Upsert logic:

- if `ref` exists → patch
- if `ref` does not exist → create

Request payload:

- message object (like `create`)

Response `data`:

```js
{ ref: string, message: object }
```

Errors:

- `BAD_REQUEST`: payload is not an object
- `VALIDATION_FAILED`: invalid message payload or patch rejected
- `CONFLICT`: create failed (for example `ref` collision after normalization)

---

### `remove`

Removes a message by `ref`.

Important: the core implements this as a **soft delete** (`lifecycle.state="deleted"` + retention/purge), so `get` may still return the deleted message.

Request payload:

- string: `'demo:task:1'`
- or object: `{ ref: 'demo:task:1' }`

Response `data`:

```js
{ ref: string, removed: boolean, message: object | null }
```

Semantics:

- when `ref` does not exist: `{ removed: false }` (no error)
- when `ref` exists: `{ removed: true }` and `message` is typically the soft-deleted message

---

### `get`

Reads one message by `ref`.

Request payload:

- string: `'demo:task:1'`
- or object: `{ ref: 'demo:task:1' }`

Response `data`:

```js
{ ref: string, message: object }
```

Errors:

- `BAD_REQUEST`: `ref` missing
- `NOT_FOUND`: message does not exist

---

### `list`

Lists messages.

Request payload (optional):

```js
{
  where?: object,  // filter
  page?: {
    size?: number, // <= 0 or missing => no pagination
    index?: number // 1-based (first page = 1)
  },
  sort?: Array<{ field: string, dir?: 'asc'|'desc' }>
}
```

`where` is passed through to the core query API (`ctx.api.store.queryMessages({ where, page, sort })`).
Common filter fields include:

- `where.kind`
- `where.level`
- `where.origin.type`
- `where.lifecycle.state`
- `where.timing.*` (range filters; e.g. `createdAt`, `updatedAt`, `expiresAt`, `notifyAt`, `timeBudget`)
- `where.details.location`
- `where.audience.tags`
- `where.dependencies`

Important default:

- If `where.lifecycle.state` is not set, `deleted` and `expired` are filtered out implicitly.

Response `data`:

```js
{ total: number, pages: number, items: object[] }
```

Note: `items` are rendered views (see `MsgRender`), not necessarily the raw stored messages.

Errors:

- `BAD_REQUEST`: invalid query (for example conflicting `{ in: [...] }` and `{ notIn: [...] }`)

---

### `action`

Executes one whitelisted action for a message (`message.actions[]` is the allow-list).

Request payload:

```js
{
  ref: 'demo:task:1',
  actionId: 'ack-1',
  actor?: 'telegram:user123', // optional attribution for lifecycle.stateChangedBy
  payload?: object|null       // optional override for action.payload (e.g. snooze.forMs)
}
```

Response `data`:

```js
{ ref: string, message: object | null }
```

Errors:

- `BAD_REQUEST`: `ref` or `actionId` missing
- `VALIDATION_FAILED`: action rejected/failed (not allowed, message missing, unsupported type, patch failed)

Supported action types in core today:

- `ack`, `close`, `delete`, `snooze`

---

## Related files

- Implementation: `lib/EngageSendTo/index.js`
- Plugin runtime: `lib/IoPlugins.js`
- Store/factory semantics: `src/MsgStore.js`, `src/MsgFactory.js`
- Schema detail: `docs/modules/MsgFactory.md`, `docs/modules/MsgConstants.md`
