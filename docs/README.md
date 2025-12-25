# MsgHub Documentation (Index)

This `docs/` tree separates **core modules** (the internal building blocks of MsgHub) from **plugins** (optional extensions that hook into well-defined integration points).

## Modules

Core modules are the stable components in `src/`. They define the schema/rules (e.g. `MsgConstants`, `MsgFactory`), hold the canonical state (`MsgStore`), and coordinate persistence/archive/rendering plus dispatching.

Read more: [docs/modules/README.md](./modules/README.md)

## Plugins

Plugins are optional integrations registered by the adapter at runtime (currently via `lib/index.js` and `main.js`). They should not mutate internal state directly; instead they work through the provided host APIs (failures are isolated and logged per plugin).

Read more: [docs/plugins/README.md](./plugins/README.md)

## Development

Handy commands and reminders: [docs/DEVELOPMENT_NOTES.md](./DEVELOPMENT_NOTES.md)
