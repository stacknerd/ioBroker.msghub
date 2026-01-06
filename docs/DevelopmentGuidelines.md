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

## i18n helper

Distribute a `{lang: text}` object into `i18n/*.json`:

`npm run i18n:push -- --dry-run --json '{"en":"MsgHub plugin (%s/%s/%s)","de":"MsgHub-Plugin (%s/%s/%s)"}'`

From a file (will be cleared after successful import; use `--keep-file` to disable):

`npm run i18n:push -- i18n-input.js`

## i18n audit / sync checks

Keep language files in sync and get a best-effort usage report:

- Report: `npm run i18n:report`
- Check (non-zero exit on sync/usage problems): `npm run i18n:check`

## i18n runtime report (optional)

For development/debugging, you can enable a runtime i18n report in the adapter instance config:

- Option: `createI18nReport`
- Output file (ioBroker file storage): `msghub.0/data/i18nReport.json`

The report contains a best-effort list of:

- `used` keys (what was actually requested at runtime)
- `missing` keys (heuristic: non-`en` language and the translated output equals the key)
