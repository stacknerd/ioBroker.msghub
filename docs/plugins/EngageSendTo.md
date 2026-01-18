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
  ref: 'demo.0.task.1',
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

Note: there are currently no user-facing plugin options (`options: {}`).

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
  ref: 'demo.0.task.1', // optional, but recommended
  kind: 'task',       // required
  level: 10,          // required
  title: 'Title',     // required
  text: 'Text',       // required
  origin: { type: 'manual', system: 'javascript.0', id: 'demo' } // required
}
```

Request payload (kitchen sink / reference):

```js
const now = Date.now();
const kind = 'task'; // 'appointment' | 'shoppinglist' | 'inventorylist' | 'status'

sendTo('msghub.0', 'create', {
  ref: 'demo.0.kitchensink.1',

  // Required core fields
  kind,
  level: 10,
  title: 'Kitchen sink example',
  text: 'Shows all supported sections (some are kind-dependent).',
  origin: { type: 'automation', system: 'javascript.0', id: 'kitchensink-1' },

  // Optional blocks
  details: {
    location: 'Basement',
    task: 'Do the thing',
    reason: 'Because',
    tools: ['screwdriver'],
    consumables: ['tape'],
  },

  audience: {
    tags: ['home', 'demo'],
    channels: { include: ['telegram'], exclude: ['tts'] },
  },

  lifecycle: {
    state: 'open',
    stateChangedBy: 'javascript.0',
  },

  timing: {
    // Note: `createdAt`/`updatedAt` are core-owned and ignored on create.
    notifyAt: now + 5 * 60 * 1000,
    remindEvery: 60 * 60 * 1000,
    cooldown: 10 * 60 * 1000,
    expiresAt: now + 7 * 24 * 60 * 60 * 1000,
    timeBudget: 15 * 60 * 1000,

    // Kind-dependent:
    dueAt: kind === 'task' ? now + 2 * 60 * 60 * 1000 : undefined,
    startAt: kind === 'appointment' ? now + 24 * 60 * 60 * 1000 : undefined,
    endAt: kind === 'appointment' ? now + 25 * 60 * 60 * 1000 : undefined,
  },

  // Note: `startedAt`/`finishedAt` are core-owned and ignored on create.
  progress: { percentage: 0 },

  dependencies: ['demo.0.other.1'],

  attachments: [
    { type: 'image', value: 'https://example.invalid/img.png' },
    { type: 'file', value: '/opt/iobroker/files/report.pdf' },
  ],

  actions: [
    { type: 'ack', id: 'ack-1' },
    { type: 'snooze', id: 'snooze-15m', payload: { forMs: 15 * 60 * 1000 } },
    { type: 'close', id: 'close-1' },
  ],

  // Only valid for list kinds:
  listItems:
    kind === 'shoppinglist'
      ? [
          { id: 'milk', name: 'Milk', category: 'dairy', quantity: { val: 2, unit: 'l' }, checked: false },
          { id: 'bread', name: 'Bread', checked: true },
        ]
      : undefined,

  // Metrics are stored as a Map in MsgHub. Over `sendTo`, patch them after create (see `patch` below).
}, res => console.log(JSON.stringify(res, null, 2)));
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
{ ref: 'demo.0.task.1', patch: { title: 'New title' } }
```

- Variant B (short form): everything except control keys is treated as a patch

```js
{ ref: 'demo.0.task.1', title: 'New title' }
```

Example: add/update/remove a `metrics` entry

```js
const ts = Date.now();

// Add or update one metric (partial update by key)
sendTo('msghub.0', 'patch', {
  ref: 'demo.0.task.1',
  patch: {
    metrics: {
      set: {
        temperature: { val: 21.7, unit: 'C', ts },
      },
    },
  },
}, res => console.log(JSON.stringify(res, null, 2)));

// Delete one metric key
sendTo('msghub.0', 'patch', {
  ref: 'demo.0.task.1',
  patch: {
    metrics: {
      delete: ['temperature'],
    },
  },
}, res => console.log(JSON.stringify(res, null, 2)));
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

- string: `'demo.0.task.1'`
- or object: `{ ref: 'demo.0.task.1' }`

Example: removing a message

```js
sendTo('msghub.0', 'remove', 'demo.0.task.1', res => {
  console.log(JSON.stringify(res, null, 2));
});
```

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

- string: `'demo.0.task.1'`
- or object: `{ ref: 'demo.0.task.1' }`

Example: reading a message

```js
sendTo('msghub.0', 'get', { ref: 'demo.0.task.1' }, res => {
  console.log(JSON.stringify(res, null, 2));
});
```

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

Example: filter + paging + sorting

```js
const now = Date.now();

sendTo('msghub.0', 'list', {
  where: {
    kind: 'task',
    lifecycle: { state: 'open' },
    timing: { notifyAt: { max: now, orMissing: true } }, // due now OR missing notifyAt
  },
  sort: [
    { field: 'level', dir: 'desc' },
    { field: 'timing.notifyAt', dir: 'asc' },
  ],
  page: { size: 10, index: 1 },
}, res => console.log(JSON.stringify(res, null, 2)));
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
  ref: 'demo.0.task.1',
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
