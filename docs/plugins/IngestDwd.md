# IngestDwd

`IngestDwd` is a Message Hub **ingest plugin** that imports weather warnings from the ioBroker `dwd` adapter into the Message Hub store.

This document has two parts:

1) A user-facing guide (setup, configuration, best practices).
2) A technical description (how it works internally).

---

## 1) User Guide

### What it does

- Reads warning objects from the `dwd` adapter (example instance `dwd.0`):
  - `dwd.0.warning.object`
  - `dwd.0.warning1.object` … `dwd.0.warning9.object`
- Creates and maintains one Message Hub message (`kind: status`) per warning.
- Removes the message again when the warning disappears from the DWD states (cause eliminated).
- Optional: summarizes `description` and `instruction` via MsgHub AI (cached).

What it intentionally does not do (today):

- It does not try to deduplicate/merge overlapping warnings (warnings are kept 1:1).

### Prerequisites

- `iobroker.dwd` must be installed and running.
- The DWD adapter must expose warning states (typically):
  - `dwd.0.numberOfWarnings`
  - `dwd.0.warning.object`, `dwd.0.warning1.object`, ...

If you want AI enhancement:

- The Message Hub adapter must have AI enabled in its instance config (provider + API key).
- The plugin option `aiEnhancement` must be enabled.

### Quick start (recommended setup)

1. Verify the DWD warning states exist (ioBroker Admin → Objects).
2. Create one `IngestDwd` instance in the Message Hub Plugins tab.
3. Set:
   - `dwdInstance` to your DWD instance (example: `dwd.0`)
   - optionally: altitude filter (`useAltitudeFilter`, `altitudeM`)
   - optionally: `audienceTagsCsv` / `audienceChannelsIncludeCsv` / `audienceChannelsExcludeCsv`
4. Enable the plugin instance (`...enable` switch).
5. Trigger a test warning (or wait for a real one) and confirm a `status` message appears in Message Hub.

### How to configure

Configuration is done in the Message Hub Admin Tab (Plugins) and uses the schema from `lib/IngestDwd/manifest.js`.

Common options:

- `dwdInstance` (string)
  - Source adapter instance (example: `dwd.0`).
- `useAltitudeFilter` / `altitudeM` (boolean / number)
  - Optional filter: only import warnings whose altitude range includes your altitude.
- `audienceTagsCsv` (string, CSV)
  - Comma-separated tags copied to `audience.tags`.
- `audienceChannelsIncludeCsv` / `audienceChannelsExcludeCsv` (string, CSV)
  - Copied to `audience.channels.include` / `audience.channels.exclude`.
- `aiEnhancement` (boolean)
  - Enables optional AI summaries for description/instruction (cached).
- `syncDebounceMs` (number, ms)
  - Debounce window for re-reading DWD warning objects after state changes.

### Altitude filter

When enabled, a warning is included when:

- `altitudeStart` and `altitudeEnd` are both present and `altitudeStart <= altitudeM <= altitudeEnd` (inclusive), or
- either altitude boundary is missing/null (treated as “always relevant”).

### Actions created

Each warning message includes:

- `ack`
- `snooze (1h)`

### Operational notes

- DWD warning slots can “move” between `warning`, `warning1`, …; the plugin does not rely on slot position.
- When a warning disappears from the DWD states, `IngestDwd` calls `api.store.completeAfterCauseEliminated(...)`:
  - for `kind: status` this removes (soft-deletes) the message.

### Troubleshooting

Common symptoms and what to check:

- “Nothing appears in Message Hub”
  - Verify `dwdInstance` is correct (`dwd.0`, `dwd.1`, ...).
  - Verify warning object states exist (e.g. `dwd.0.warning.object`) and contain non-empty objects (not `{}`).
  - Check adapter logs for `IngestDwd` warnings about `getForeignState`.

- “Warnings are missing because of altitude”
  - Temporarily disable `useAltitudeFilter` to verify the upstream warning feed.
  - Confirm your `altitudeM` is within the warning’s `altitudeStart/altitudeEnd` (inclusive).

- “AI enhancement does not run”
  - Confirm MsgHub AI is enabled in the adapter instance config and has a valid API key.
  - Confirm `aiEnhancement=true` in the plugin instance config.

---

## 2) Software Documentation

### Overview

`IngestDwd` is registered as an **ingest** plugin:

- Registration id: `IngestDwd:<instanceId>` (example: `IngestDwd:0`)
- Implementation: `lib/IngestDwd/index.js`
- Manifest: `lib/IngestDwd/manifest.js`

### Input signals

The plugin subscribes to these foreign states:

- `<dwdInstance>.numberOfWarnings`
- `<dwdInstance>.warning.object`
- `<dwdInstance>.warning1.object` … `<dwdInstance>.warning9.object`

On changes, it re-reads all warning object states (debounced) and rebuilds the “desired warning set”.

### Message identity and stability

The DWD adapter does not provide a stable warning id, and warnings can “move” between warning slots.

`IngestDwd` therefore computes a stable hash from “stable” warning fields and uses:

- `ref = IngestDwd.<instanceId>.<hash>`
- `origin.id = <hash>`

Time fields like `start/end` are intentionally **not** part of the hash, so time adjustments patch the existing message
instead of creating a new one.

### Store mutations

For each current warning, the plugin upserts a message:

- `kind`: `status`
- `origin.type`: `import`
- `origin.system`: `<dwdInstance>`
- `timing.expiresAt`: `warning.end`

Removal:

- For refs that were previously present (prefix `IngestDwd.<instanceId>.`) but are no longer in the current warning set,
  the plugin calls `api.store.completeAfterCauseEliminated(ref, { actor: 'IngestDwd:<instanceId>' })`.

### Optional internal persistence (AI cache)

When `aiEnhancement=true`, the plugin maintains one internal JSON state:

- `msghub.0.IngestDwd.<instanceId>.aiCache`

It stores cached summaries keyed by the warning hash, and also uses the core AI cache (`ctx.api.ai`) for best-effort reuse.
