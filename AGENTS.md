# AGENTS.md – ioBroker.msghub (Message Hub)

Dieses Repo ist ein ioBroker-Adapter („Message Hub“), der eine persistente Liste von **Messages** (Tasks/Status/Termine/…) verwaltet und Ereignisse über Plugins an Integrationen ausgibt.

## Einstieg (Doku/Code-Mapping)

- Überblick + Lese-Reihenfolge: `docs/README.md`
- Message-Objektmodell (`ref`, `kind`, `level`, Lifecycle, Timing): `docs/MessageModel.md`
- Plugin-Developer-Guide (Interfaces, `ctx.api`, Plugin-Familien): `docs/plugins/README.md`
- Plugin-Runtime (Enable-States, `native` Options, Registration): `docs/plugins/IoPlugins.md`
- Repo-Konventionen (Naming/IDs/i18n): `docs/DevelopmentGuidelines.md`
- Adapter-Wiring: `main.js` (init Store + IoPlugins + AdminTab)

## Wichtige Befehle (lokal/CI)

- Node-Version: `>= 22` (siehe `package.json`)
- Tests: `npm test` (oder gezielt `npm run test:js`, `npm run test:package`, `npm run test:integration`)
- Lint: `npm run lint`
- Typecheck (tsc checkJs): `npm run check`
- Doku-Index/Stub-Generierung: `npm run docs:generate`
- Doku-Index-Check (CI): `npm run docs:check`
- Dev-Server (ioBroker): `npm run dev-server`

## Repo-Struktur (wo was hingehört)

- `src/`: Core-Engine (Store, Factory, Render, Notify/Engage/Bridge-Host, Utils)
- `lib/`: IO-Layer + Runtime („Plugins“ und `IoPlugins`)
- `admin/`: Admin-UI (Tabs/JS/CSS für ioBroker Admin)
- `docs/`: Software-Dokumentation (Module + Plugins)
- `i18n/`: Übersetzungen für UI/Plugin-Metadaten
- `test/` + `*.test.js`: Mocha-Tests

## Coding Style / Konventionen

- Einrückung: Tabs; Quotes: `'single'` (siehe `.editorconfig`, `prettier.config.mjs`).
- CommonJS + `'use strict';` ist Standard.
- JSDoc sparsam: `@param`/`@returns` ok; vermeide neue `@type`/`@typedef`-Blöcke, da ESLint (`eslint-plugin-jsdoc`) diese hier oft bemängelt.
- Kleine, fokussierte Änderungen (nicht großflächig umformatieren).

## Domänenregeln (wichtig für Korrektheit)

- **Message-Identität:** `ref` ist der stabile Schlüssel (Dedupe/Update/Delete). Neue Ingest-Quellen sollten stabile `ref`s erzeugen.
- **Maps in JSON:** `metrics` werden intern als `Map` geführt; für JSON-Ausgabe/States Map-Serialisierung über `src/MsgUtils.js` verwenden (z.B. `serializeWithMaps`).
- **Plugin-Grenzen:** `Notify...` ist „one-way“ (ausgeben/liefern) und soll den Store nicht mutieren; Aktionen sind Aufgabe von `Engage...`.

## Plugin-System (lib/ + Runtime)

Plugin-Familien (Namenspräfix ist relevant): `Ingest...` / `Notify...` / `Bridge...` / `Engage...`.

### Naming + IDs (kompatibilitätsrelevant)

- Plugin-Type-Namen: `Ingest<System>`, `Notify<System>`, `Bridge<System>`, `Engage<System>`
- Plugin-Config-Tree (ioBroker): `msghub.<adapterInstance>.<TypeName>.<instanceId>` (instanceId ist numerisch; heute meist `0`)
- Registration-ID (in Hosts): `<TypeName>:<instanceId>` (z.B. `NotifyStates:0`)

### Plugin hinzufügen (Standardpfad)

1. Ordner anlegen: `lib/<TypeName>/`
2. `lib/<TypeName>/manifest.js` exportiert `{ manifest }` (mind. `manifest.type`)
3. `lib/<TypeName>/index.js` exportiert eine Factory-Funktion **mit exakt dem Namen von** `manifest.type`
4. Doku: `docs/plugins/<TypeName>.md` (optional via `npm run docs:generate`)

Hinweis: `lib/index.js` baut den Katalog zur Laufzeit durch Scan von `lib/*/manifest.js` und verlangt:

- `module.exports.manifest` (Objekt)
- `module.exports[manifest.type]` (Factory-Funktion)

Die `manifest.options`-Defaults sind „Source of truth“ für neue Instanzen: `IoPlugins` nutzt sie, um `object.native` beim ersten Anlegen zu seeden.

### Runtime-Wiring / ioBroker-Objekte

`IoPlugins` (`lib/IoPlugins.js`) erzeugt pro Plugin-Instanz eine Subtree-Struktur unter `msghub.<instance>.…`:

- Base-Object: `...<Type>.<instanceId>` (Options in `object.native`)
- Enable-State: `...<Type>.<instanceId>.enable` (boolean; User-Intent ist `ack:false`)
- Status-State: `...<Type>.<instanceId>.status` (`starting|running|stopping|stopped|error`)

Plugins erhalten ihre Options aus `native` plus `options.pluginBaseObjectId` (vollständige ID), um eigene States sauber darunter anzulegen.

## Admin-UI

- Admin-Dateien liegen unter `admin/` (Browser-JS, kein Node-API).
- Plugin-Config-Tab ist `admin/tab.plugins.js` und arbeitet gegen `sendTo('admin.*', ...)` Commands.

## Doku-Regeln

- Auto-generierte Index-Abschnitte in `docs/**/README.md` nicht manuell im Marker-Block editieren (werden durch `generate-doc-index.mjs` überschrieben).
- Wenn du neue Module/Plugins hinzufügst oder umbenennst: `npm run docs:generate` + `npm run docs:check`.

## i18n

- Texte liegen in `i18n/*.json`; für neue Keys bevorzugt den Push-Workflow aus `docs/DevelopmentGuidelines.md` nutzen.
- Helfer: `npm run i18n:push` (z.B. mit `i18n-input.js`).
