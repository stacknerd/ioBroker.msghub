# Development Guide

## Naming / Branding

The adapter is called **Message Hub**.

For compatibility and shorter identifiers, the codebase and ioBroker integration still use these short forms:

- Repository/package name: `ioBroker.msghub` / `iobroker.msghub`
- Adapter namespace (state IDs): `msghub.<instance>.…` (example: `msghub.0.NotifyStates.0.Latest.due`)
- Internal class prefix: `Msg*` (example: `MsgStore`, `MsgFactory`)

Documentation and UI text should prefer:

- Use **“Message Hub”** as the public-facing product name.
- Use `msghub` only when you mean the technical identifier/namespace (repo, package, state IDs, config keys, code).

## Plugin Structure (`lib/`)

Convention: plugin code stays in `lib/` and must be uniquely attributable by path.

- `lib/index.js`: plugin catalog builder (autodiscovery) exporting `IoPluginsCatalog` + discovered factories.
- `lib/<PluginName>/manifest.js`: plugin manifest (type/title/description/options schema).
- `lib/<PluginName>/index.js`: plugin entry file (exports the factory + `manifest`).
- `lib/<PluginName>/...`: optional plugin submodules (e.g. per evaluator/rule type).

Example `IngestMySystem`:

- Entry: `lib/IngestMySystem/index.js`
- Submodules (optional): `lib/IngestMySystem/Trigger.js`, `lib/IngestMySystem/Freshness.js`, ...

## Plugin Naming + ID Schemas (keep consistent)

When adding new plugins, keep the naming and ID schemas uniform. Many parts of the system (and docs/tests) assume these conventions.

### Plugin type names

- Ingest (producer): `Ingest<System>`
- Notify (delivery): `Notify<System>`
- Bridge (bidirectional): `Bridge<System>`
- Engage (interactive): `Engage<System>`

### Runtime instance ids / registration ids

- Instance ids are numeric and start at `0`.
- Plugins may allow multiple instances (`manifest.supportsMultiple === true`); ids are assigned automatically (`0`, `1`, `2`, …).
- Registration id (inside the hosts): `<TypeName>:<instanceId>` (example: `IngestMySystem:0`, `NotifyStates:0`)
- Plugin config object id (ioBroker tree): `<adapter.namespace>.<TypeName>.<instanceId>` (example: `msghub.0.IngestMySystem.0`)

### Message `ref` schema (dedupe key)

Producers must create stable `ref`s so updates don’t create duplicates and messages survive restarts/hydration.

Guidelines:

- Use a simple, dot-separated format: `<system>.<instance>.<topic>.<sourceId>`
- Keep it technical and stable (do not use localized names, no spaces).
- Include the external/source id when available (full ioBroker state id/object id is fine).

Example (`IngestMySystem`):

- Battery: `mysystem.0.battery.<stateId>` (e.g. `mysystem.0.battery.some.0.device.battery`)
- Reachable: `mysystem.0.reachable.<stateId>` (e.g. `mysystem.0.reachable.some.0.device.reachable`)

## i18n workflow

This repo uses stable i18n keys (not English texts) and maintains language files with helper scripts:

- Generate/sync language files: `npm run i18n:generate`
- Mirror admin i18n keys into runtime i18n (for `ctx.api.i18n.t`): `npm run i18n:mirror:admin-to-runtime`
- Generate + remove keys that do not exist in `en.json` (opt-in): `npm run i18n:generate:remove`
- Sort keys (deterministic): `npm run i18n:sort`
- Check key sync (CI-friendly): `npm run i18n:check`

## i18n keying guideline (new keys)

New i18n strings should use stable keys (not default texts) so they are searchable, rename-safe and easy to audit.

### Key prefix + scope

- Prefix: `msghub.i18n.`
- Core strings: `msghub.i18n.core.<area>...`
- Plugin strings: `msghub.i18n.<PluginTypeName>.<area>...` (example: `msghub.i18n.EngageTelegram...`)

Notes:

- `<PluginTypeName>` must match `manifest.type` (e.g. `IngestStates`, `NotifyStates`, `EngageTelegram`).
- Do not include plugin instance ids in keys (no `.0.` etc.).

### Areas + suffixes

Use a small set of areas and always end keys with what the string represents:

- Areas (recommended): `admin`, `ui`, `msg`, `error`, `format`, `unit`
- Suffixes: `.label`, `.help`, `.title`, `.text`, `.action`, `.hint`, `.caption`, `.format`, `.unit`

Examples:

- `msghub.i18n.core.admin.jsonConfig.general.locale.label`
- `msghub.i18n.core.admin.jsonConfig.general.locale.help`
- `msghub.i18n.EngageTelegram.action.ack`
- `msghub.i18n.IngestStates.msg.threshold.title`
- `msghub.i18n.IngestStates.msg.threshold.text.aboveLimit`

### Style rules

- Allowed characters: `[A-Za-z0-9.]` (dot-separated segments).
- Keys are semantically named, not based on English sentence texts.
- Prefer string literals in `i18n.t('...')` calls (avoid concatenated/dynamic keys) so keys stay searchable and reviewable.

## i18n sync checks

Keep language files in sync:

- `npm run i18n:check` checks that all language files contain the same keys as the base language (`en`).
- `npm run i18n:sort` enforces deterministic key order (recommended before commits).
- If you want both in one step: run `npm run i18n:sort` then `npm run i18n:check` (or use `node i18n-check.mjs --scope all --sort`).

## i18n runtime report (optional)

For development/debugging, you can enable a runtime i18n report in the adapter instance config:

- Option: `createI18nReport`
- Output file (ioBroker file storage): `msghub.0/data/i18nReport.json`

The report contains a best-effort list of:

- `used` keys (what was actually requested at runtime)
- `missing` keys (heuristic: non-`en` language and the translated output equals the key)
