# Ingest: IngestRandomChaos (demo/load generator)

`IngestRandomChaos` is a Message Hub **ingest plugin** that injects “compressed realism” into the store:
it periodically creates, updates, and removes messages so you can observe UI behavior, notification routing, and general performance under light load.

This plugin is intentionally **non-deterministic** and does not try to be a strict simulator.

---

## Basics

- Type: `Ingest`
- Registration ID: `IngestRandomChaos:0`
- Implementation: `lib/IngestRandomChaos/index.js` (`IngestRandomChaos(options)`)
- Purpose: demo traffic + light load generation

---

## Behavior

While the plugin is enabled (running):

- It runs on a timer and performs one operation per tick.
- It maintains a small in-memory “pool” of message refs and reuses them (bounded by `maxPool`) to avoid unbounded archive spam.
- Operations:
  - create new messages (`task` and `status`)
  - update existing messages (text/level + lifecycle transitions)
  - remove existing messages (soft delete via `store.removeMessage`)
  - update metrics on some messages that have metrics

When the plugin is stopped, it removes (soft-deletes) all messages it managed in the current run so it leaves no visible “chaos” behind.

### Message characteristics

- Kinds: `task` and `status`
- Levels: uses all numeric values from `MsgConstants.level`
- Excluded on purpose (for now): `listItems`, `actions`, `dependencies`, `attachments`
- Origin attribution:
  - `origin.type = "automation"`
  - `origin.system = "IngestRandomChaos"`
  - `origin.id = "IngestRandomChaos"`

### Lifecycle transitions (examples)

The plugin tries to apply plausible sequences, for example:

- `open → acked → closed`
- (tasks only) `open → snoozed → open`

---

## Options (`native`)

Options are stored in the plugin’s ioBroker object `native` and passed as-is to the factory:

- `intervalMinMs` (`number`, default `2000`): minimum delay between ticks.
- `intervalMaxMs` (`number`, default `5000`): maximum delay between ticks.
- `maxPool` (`number`, default `10`): maximum number of concurrently active messages managed by this plugin.

---

## Runtime wiring (IoPlugins)

When enabled via the built-in plugin runtime:

- Base object id: `msghub.0.IngestRandomChaos.0`
- Enable switch: `msghub.0.IngestRandomChaos.0.enable`
- Status: `msghub.0.IngestRandomChaos.0.status`

---

## Related files

- Implementation: `lib/IngestRandomChaos/index.js`
- Plugin host: `src/MsgIngest.js`
- Store + mutations: `src/MsgStore.js`
- Message normalization: `src/MsgFactory.js`
- Plugin overview: `docs/plugins/README.md`
