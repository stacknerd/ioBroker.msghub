# NotifyShoppingPdf

`NotifyShoppingPdf` is a Message Hub **notify plugin** that renders all allowed MsgHub shopping lists into a **single PDF**
and stores it in ioBroker’s file storage.

This document has two parts:

1) A user-facing guide (setup, configuration, best practices).
2) A technical description (how it works internally).

---

## 1) User Guide

### What it does

- Listens to MsgHub notifications for `shoppinglist` messages (`added`, `updated`, `deleted`, `expired`).
- Regenerates a single combined PDF (debounced/throttled via `renderDebounceMs`).
- Stores the PDF in ioBroker file storage under `msghub.0/documents/NotifyShoppingPdf.<instanceId>.pdf`.

### What it intentionally does not do

- No fallbacks outside the MsgHub runtime (`IoPlugins`): it expects `ctx.api.*` capabilities and the adapter environment.
- No PDF rendering without LaTeX: `pdflatex` must be available.
- No sorting: shopping lists and items are rendered “as delivered” by MsgHub.

### Prerequisites

- `pdflatex` must be installed and available on `PATH`.
- The LaTeX template uses packages like `tcolorbox`, `multicol`, `tabularx`, `fancyhdr`, `lastpage` (Debian often needs `texlive-latex-extra`).
- The Message Hub adapter must be running and have shopping list messages (`kind: shoppinglist`) in the store.

If `pdflatex` is missing, the plugin fails to start and the instance stays in `error`.

Example (Debian):

```sh
sudo apt-get install texlive-latex-base texlive-latex-extra
```

### Output location (ioBroker file storage)

The plugin writes one PDF per plugin instance:

- `msghub.0/documents/NotifyShoppingPdf.<instanceId>/<pdfTitle>.pdf`

Example:

- `msghub.0/documents/NotifyShoppingPdf.0/Einkaufsliste.pdf`

You can view/download it via ioBroker Admin → Files (or any integration that can read adapter file storage).

### States written by the plugin

After every successful generation, the plugin writes two states below its instance subtree:

- `msghub.0.NotifyShoppingPdf.<instanceId>.pdfPath`
  - Value: `msghub.0/documents/NotifyShoppingPdf.<instanceId>/<pdfTitle>.pdf`
- `msghub.0.NotifyShoppingPdf.<instanceId>.pdfUrl`
  - Best-effort URL to the PDF:
    - If `web.0` is detected: `http(s)://<host>:<port>/files/msghub.0/documents/...`
    - Otherwise: `/files/msghub.0/documents/...` (relative path)

### Configuration

Configuration is done in the Message Hub Admin Tab (Plugins) and uses the schema from `lib/NotifyShoppingPdf/manifest.js`.

Common options:

- `includeChecked` (boolean; default `true`)
  - When enabled, checked items are included (rendered greyed out).
- `audienceTagsAnyCsv` (string CSV; default empty)
  - Comma-separated audience tags to include.
  - If set, only shopping lists with at least one matching `audience.tags[]` entry are included.
- `renderDebounceMs` (number; default `1000`)
  - Debounce window for regenerating the PDF when notifications arrive.
- `printRoomLabelsFromItems` (number; default `6`)
  - Prints `listItem.category` section headings only when the list has more than this number of printed items.
- `includeEmptyCategories` (boolean; default `true`)
  - If disabled, lists with 0 printed items are omitted from the PDF.
- `design` (string; default `print`)
  - `screen` uses lighter lines; `print` uses stronger lines.
- `notesLines` (number; default `5`)
  - Adds a localized “NOTES/NOTIZEN” block at the end of the PDF (`0` disables it).

### How the PDF layout maps to MsgHub data

- **Category cards** in the PDF correspond to shopping list messages.
  - `category` label = `message.title` (fallback: `message.ref`).
- Inside each card, **rooms/sections** correspond to list item categories:
  - `room.label` = `listItem.category` (fallback: `uncategorizedLabel`).
- Each printed line corresponds to one `listItems[]` entry and shows a checkbox:
  - `checked=false` → empty box
  - `checked=true` → checkmark (and greyed out text if `includeChecked=true`)

The PDF subtitle is a localized “generated at” timestamp derived from `system.config.common.language`
(example: `Sonntag, 04.01.2026 02:10`).

---

## 2) Technical Description

### Triggering / throttling

The plugin runs on notify-side events:

- `added`
- `updated`
- `deleted`
- `expired`

It filters for:

- `msg.kind === "shoppinglist"`
- (optional) `msg.audience.tags` matching `audienceTagsAnyCsv` (any)

When a relevant notification is received, the plugin schedules a PDF render using a debounce timer
(`ctx.meta.resources.setTimeout`).

### Data source

Rendering reads the current store snapshot:

- `ctx.api.store.queryMessages({ where: { kind: 'shoppinglist', timing: { startAt: { max: now, orMissing: true } }, audience: { channels: { routeTo: ctx.meta.plugin.channel } } } })`

The PDF content is derived from all **allowed** `shoppinglist` messages. By default, MsgHub queries exclude
`deleted` and `expired` messages unless explicitly requested via `where.lifecycle.state`.

Additionally, the plugin only includes shopping lists where `timing.startAt` is either missing (unscheduled) **or**
set to a timestamp in the past (`startAt <= now`). Future scheduled lists (`startAt > now`) are skipped.
This is implemented directly in the query via `timing.startAt.orMissing` (no local post-filtering).

Note: channel routing uses the same semantics as `IoPlugins` notification routing:

- `audience.channels.include` scopes messages to specific plugin channels.
- `audience.channels.exclude` blocks specific channels (exclude wins).
- If the plugin channel is empty, only unscoped messages (`include` empty) are included.

### File writing

The plugin compiles LaTeX via `pdflatex` in a temporary folder and then writes the resulting PDF into ioBroker file storage
via the MsgHub plugin API:

- `ctx.api.iobroker.files.mkdir(metaId, 'documents')`
- `ctx.api.iobroker.files.writeFile(metaId, 'documents/NotifyShoppingPdf.<instanceId>.pdf', pdfBuffer)`

The `metaId` is the adapter namespace (`ctx.api.iobroker.ids.namespace`, typically `msghub.0`).
