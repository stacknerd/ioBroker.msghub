# IngestRandomChaos

`IngestRandomChaos` is a Message Hub **ingest** plugin that injects “compressed realism” into the store: it periodically creates, updates, and removes messages so you can observe UI behavior, notification routing, and general performance under light load.

This plugin is intentionally **non-deterministic** and does not try to be a strict simulator.

This document has two parts:

1) A user-facing guide (setup, configuration, best practices).
2) A technical description (how it works internally).

---

## 1) User Guide

### What it does

- Periodically creates, updates, and removes a small pool of messages.
- Generates both `task` and `status` messages with plausible lifecycle transitions.
- Cleans up after itself on stop by soft-deleting messages it managed in the current run.

What it intentionally does not do:

- It is not deterministic and not a strict simulator.
- It does not try to cover every message feature (for example no `listItems`, `actions`, `attachments`, ...).

### Prerequisites

- None. This plugin is self-contained and does not read foreign states.

### Quick start (recommended setup)

1. Create an `IngestRandomChaos` instance in the Message Hub Plugins tab.
2. Keep the defaults or set reasonable values:
   - `intervalMinMs=2000`
   - `intervalMaxMs=5000`
   - `maxPool=10`
3. Enable the plugin instance (`...enable` switch).
4. Watch the Message Hub message list and/or notifier outputs (for example `NotifyStates`).

### How to configure

Configuration is done in the Message Hub Admin Tab (Plugins) and uses the schema from `lib/IngestRandomChaos/manifest.js`.

Options:

- `intervalMinMs` (number, ms, default `2000`)
  - Minimum delay between ticks.
- `intervalMaxMs` (number, ms, default `5000`)
  - Maximum delay between ticks (clamped to be `>= intervalMinMs`).
- `maxPool` (number, default `10`)
  - Maximum number of concurrently “active” messages managed by this plugin.

### Best practices

- Use this plugin for development/testing only; keep it disabled in production.
- Keep `maxPool` small to avoid archive spam and to keep notifier/state churn manageable.
- Pair it with notifier plugins (for example `NotifyStates`) to validate routing behavior.

### Troubleshooting

- “Nothing happens”
  - Verify the plugin instance is enabled and running.
  - Ensure `intervalMaxMs` is not accidentally set below `intervalMinMs`.

- “Too many messages”
  - Reduce `maxPool` and/or increase the intervals.

---

## 2) Software Documentation

### Overview

`IngestRandomChaos` is registered as an **ingest** plugin:

- Registration id: `IngestRandomChaos:<instanceId>` (example: `IngestRandomChaos:0`)
- Implementation: `lib/IngestRandomChaos/index.js`

While running, it schedules a timer tick and performs one operation per tick (create/update/remove).

### Runtime wiring (IoPlugins)

- Base object: `msghub.0.IngestRandomChaos.<instanceId>`
- Enable state: `msghub.0.IngestRandomChaos.<instanceId>.enable`
- Status state: `msghub.0.IngestRandomChaos.<instanceId>.status`

### Message identity and pool behavior

- Message refs are stable per plugin run and bounded by `maxPool`, so the archive footprint stays bounded.
- Ref format:
  - `IngestRandomChaos.<instanceId>.<runId>.<kind>.<slot>`
  - Example: `IngestRandomChaos.0.<runId>.task.3`

### Message characteristics

- Kinds: `task` and `status`
- Levels: random pick from `MsgConstants.level`
- Origin attribution:
  - `origin.type = "automation"`
  - `origin.system = "IngestRandomChaos"`
  - `origin.id = "IngestRandomChaos"`
- Metrics:
  - Some messages include `metrics` (stored as `Map` in the canonical store).
  - Updates use `metrics: { set: { ... } }` patches for those messages.

Excluded on purpose:

- `listItems`, `actions`, `dependencies`, `attachments`

### Lifecycle transitions

The plugin tries to apply plausible sequences, for example:

- `open → acked → closed`
- (tasks only) `open → snoozed → open`

### Stop behavior

On `stop()`, the plugin soft-deletes all refs in its pool via `store.removeMessage(ref)` and clears the pool.

### Related files

- Implementation: `lib/IngestRandomChaos/index.js`
- Plugin host: `src/MsgIngest.js`
- Store + mutations: `src/MsgStore.js`
- Message normalization: `src/MsgFactory.js`
- Plugin overview: `docs/plugins/README.md`
