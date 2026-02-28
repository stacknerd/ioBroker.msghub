# MsgStats (Message Hub): on-demand insights + persistent rollups

`MsgStats` provides a **JSON-serializable statistics snapshot** over the Message Hub store.
It is designed for diagnostics and UIs (for example the Admin tab), without keeping constantly updated counters in RAM.

The key idea: compute “current” numbers **on demand** from the store list, but keep a tiny **persistent rollup** for
completed messages (“done”) so longer time windows remain possible even when the store later deletes those messages.

---

## Where it sits in the system

`MsgStats` is owned by `MsgStore`:

- `MsgStore` creates `this.msgStats = new MsgStats(...)` during construction.
- `MsgStore.init()` calls `await msgStats.init()` to load the persisted rollup file.
- `MsgStore.updateMessage()` calls `msgStats.recordClosed(updatedMessage)` **exactly when** the message transitions
  into `lifecycle.state === "closed"`.
- Consumers call `MsgStore.getStats(...)`, which delegates to `MsgStats.getStats(...)` after a prune pass.

Primary consumers today:

- Admin tab: `admin.stats.get` (`lib/IoAdminTab.js`) → `msgStore.getStats(...)` → `MsgStats.getStats(...)`
- Plugins: `ctx.api.stats.getStats(...)` (see `docs/plugins/API.md`)

`MsgStats` reads from:

- the in-memory store list (`MsgStore.fullList`) for “current” and “schedule”
- `MsgStorage.getStatus()` for persistence info
- `MsgArchive.getStatus()` (and optionally `MsgArchive.estimateSizeBytes(...)`) for archive info

---

## Core responsibilities

1. **Current snapshot**
   - totals and breakdowns over the current in-memory list (`fullList`)
   - buckets: by kind, by lifecycle state, by level, by origin system (`origin.system`)

2. **Schedule buckets (“fällig”, domain time)**
   - counts of messages that have a domain due timestamp
   - windows: overdue, today, tomorrow, next 7 days, this week, this month
   - additional “from today” windows (exclude overdue): this week (from today), this month (from today)
   - grouped by kind

3. **Done rollup (persistent)**
   - counts of messages completed by a **transition to `lifecycle.state="closed"`**
   - windows: today / this week / this month
   - survives store retention, hard-deletes, and ref re-creation

4. **I/O status (diagnostics)**
   - storage: last persisted timestamp/bytes, pending status
   - archive: last flush timestamp, pending queue size, optional archive size estimate

---

## Domain semantics: “fällig” vs “due notification”

This module intentionally distinguishes two different concepts:

- **Domain time** (“fällig”): `timing.dueAt` for tasks/lists; `timing.startAt` for appointments.
- **Notification event `"due"`**: a reminder delivery event driven by `timing.notifyAt`.

`MsgStats.schedule.*` uses **domain time only**. It does not look at `notifyAt`.

See also: `docs/MessageModel.md` (Timing section).

---

## Persistence model (why rollups exist)

“Done this week/month” cannot be derived reliably from the current store list, because:

- closed/expired/deleted messages can be hard-deleted later (retention)
- a message `ref` can be re-created and replace a previous message (the old one disappears from the list)

Therefore, `MsgStats` maintains a tiny append-less rollup file:

- file: `data/stats-rollup.json` (ioBroker file store under adapter namespace)
- content: day buckets (`YYYY-MM-DD` local time) with `total` and `byKind`
- retention: `rollupKeepDays` (default `400`)

The rollup is updated only when a message transitions into `closed` (`recordClosed(...)`).

---

## Public API (what you typically use)

Most callers should not construct `MsgStats` directly. Use:

- `MsgStore.getStats(options?)` (adapter-internal)
- `ctx.api.stats.getStats(options?)` (plugin API)

### `getStats(options?)`

Returns a JSON object shaped like:

- `meta`: generatedAt, time zone, locale, and computed window boundaries
- `current`: total + breakdowns
- `schedule`: due buckets (domain “fällig”)
- `done`: rollup buckets (today/thisWeek/thisMonth) + lastClosedAt
- `io`: storage + archive status

Notes on shape:

- `current.byOriginSystem` is derived from `message.origin.system` and is useful to understand which integration/system
  currently “owns” most messages (falls back to `"unknown"` when missing).
- `schedule.thisWeekFromToday` and `schedule.thisMonthFromToday` are “UI-friendly” counterparts to `thisWeek`/`thisMonth`:
  they count due timestamps **from start of today**, which means they exclude the overdue portion.

Options are used for opt-in / expensive fields:

- `options.include.archiveSize === true` triggers `MsgArchive.estimateSizeBytes(...)` before returning `io.archive`.
- `options.include.archiveSizeMaxAgeMs` controls caching for that estimate.

### `recordClosed(message)`

Records one close transition into the rollup.

Expected:

- `message.lifecycle.state === "closed"`
- `message.lifecycle.stateChangedAt` should be set (falls back to `Date.now()`).

This method is called by `MsgStore` on the closed transition; consumers should not need it.

---

## Design guidelines / invariants (the important rules)

### 1) Snapshot-first (no live counters)

The “current” and “schedule” parts are computed by scanning `MsgStore.fullList` at request time.
This keeps runtime overhead low (no bookkeeping on every mutation) and avoids subtle counter drift.

### 2) Minimal persistence (only what cannot be re-derived)

Only the “done” rollup is persisted, because it cannot be reconstructed once the store deletes/hard-deletes old messages.

### 3) Local time windows are explicit

All window boundaries are computed in **local time**:

- day start: local midnight
- week start: Monday 00:00 local time
- month start: first day of month 00:00 local time

Schedule windows recap:

- `overdue`: due timestamp < start of today
- `today`: start of today ≤ due < start of tomorrow
- `tomorrow`: start of tomorrow ≤ due < start of day after tomorrow
- `next7Days`: start of today ≤ due < start of today + 7 days
- `thisWeek`: start of local week ≤ due < start of next local week (calendar week window)
- `thisWeekFromToday`: start of today ≤ due < start of next local week (calendar week window, excluding overdue)
- `thisMonth`: start of local month ≤ due < start of next local month (calendar month window)
- `thisMonthFromToday`: start of today ≤ due < start of next local month (calendar month window, excluding overdue)

### 4) Expensive fields must be opt-in

Archive size estimation can be slow depending on backend and file count.
It is behind `include.archiveSize` and cached by `maxAgeMs`.

---

## Related files

- Implementation: `src/MsgStats.js`
- Store wiring: `src/MsgStore.js` (`getStats`, closed transition hook)
- Storage diagnostics: `src/MsgStorage.js` (`getStatus`)
- Archive diagnostics: `src/MsgArchive.js` (`getStatus`, `estimateSizeBytes`)
- Admin endpoint: `lib/IoAdminTab.js` (`admin.stats.get`)
- Admin UI: `admin/tab.stats.js` (Stats tab)
- Plugin API reference: `docs/plugins/API.md` (`ctx.api.stats`)
- Module overview: `docs/modules/README.md`
