# IngestStates Presets Refactor Plan

Status: review pending

## Ausgangszustand vor Block 1

Der aktuelle Worktree-Zustand ist bewusst nicht die Zielstruktur dieses Refactors.

Insbesondere ist die aktuelle `lib/IngestStates/admin-ui/dist/presets.esm.js` ein Pre-Block-1-Zwischenzustand und keine akzeptierte Baseline. Sie enthält bereits top-level Helper, die in diesem Plan ausdrücklich verboten sind.

Konkret betrifft das den aktuellen Zwischenstand mit:

- `createPresetsRpcApi`
- `cloneJson`
- `parseCsvList`
- `formatCsvList`
- `createHostBridge`
- `createBootstrapModel`
- `createBundleContext`

Block 1 ersetzt diesen Zwischenstand bewusst durch einen echten Neuaufbau ab leerem File.

## Ziel

`lib/IngestStates/admin-ui/dist/presets.esm.js` wird vor dem ersten Commit des Ports aus einer leeren Datei neu aufgebaut.

Ziel ist ausschließlich ein interner Zuschnitt-Refactor. Das Verhalten der Datei ändert sich dabei nicht.

Freigabekriterium:

- gleicher sichtbarer Output
- gleiche Bedienpfade
- gleiche i18n-Key-Nutzung
- gleiche RPC-Aufrufe
- gleiche Host-Nutzung
- gleiche Fehlerpfade
- gleiche Testsicht

Der Refactor darf die Datei nur anders schneiden, nicht anders agieren lassen.

## Verbindliche Leitplanken

1. Light DOM, plugin-owned i18n und der bestehende Host-/RPC-Schnitt bleiben unverändert.
2. Kein Layer-Leakage:
   - kein Import aus `src/**`
   - keine Umgehung von `docs/plugins/API.md`
   - keine Nutzung von `this.adapter` im Frontend-/Bundle-Code
3. Kein stiller Architekturumbau:
   - kein neues Build-System
   - kein neues `src/`-Verzeichnis
   - keine neue Public-API am Host ohne explizite Freigabe
4. Keine funktionalen Änderungen:
   - keine neue Logik
   - keine neue UX
   - keine neue DOM-Struktur
   - keine neuen oder entfernten Bedienpfade
   - keine geänderten Fehlerpfade
   - keine geänderten RPC-Sequenzen
   - keine geänderte i18n-Semantik
5. Keine stillen Zusatzarbeiten:
   - keine Drive-by-Fixes
   - keine ungefragten UX-Änderungen
   - keine neuen i18n-Keys ohne explizite Entscheidung
6. Kommentar- und JSDoc-Regeln aus Governance gelten weiterhin:
   - Dateiheader
   - JSDoc an jeder internen Funktion/Methode
   - englische Kommentare
7. Nach jedem Block wird gestoppt. Kein Durchrennen über Review-Grenzen hinweg.

## Governance-Commit

Die Ausführung dieses Refactors folgt verbindlich:

- `docs/DevelopmentGuidelines.md`
- `docs/plugins/API.md`
- `docs/ui/AdminTab.md`
- den bereits herangezogenen Governance-Regeln aus dem internen Review:
  - Design approval before coding
  - Atomic Refactor Delivery
  - No Rescue Refactor
  - Re-read norm docs after interruption
  - lint/check/tests stay mandatory

Praktische Konsequenz:

- Kein Hybrid-Zustand als Ziel.
- Jeder Block bleibt in sich überprüfbar.
- Kein Block wird als "fertig" gemeldet, solange bekannte Restpunkte in genau diesem Block offen sind.
- Jeder Block ist ein reiner Zuschnitt-Schritt ohne funktionale Abweichung gegenüber dem bereits vorhandenen Presets-Port.

## Test-Gate-Regelung

`lib/IngestStates/admin-ui/dist/presets.esm.test.js` testet das volle Zielverhalten des fertigen Bundles und ist für die Zwischenblöcke 1 bis 5 bewusst noch nicht passend.

Darum gilt für diesen Refactor verbindlich:

- Block 1 bis Block 5:
  - `eslint` auf die geänderte Datei bleibt Pflicht
  - `node --check lib/IngestStates/admin-ui/dist/presets.esm.js` bleibt Pflicht
  - alle anderen vom Refactor unberührten Tests bleiben grün
  - `lib/IngestStates/admin-ui/dist/presets.esm.test.js` ist in Block 1 bis 5 ein bekannt roter Zieltest und kein Freigabe-Gate
- Block 6:
  - `lib/IngestStates/admin-ui/dist/presets.esm.test.js` wird wieder an den Stand gebracht, der das volle Zielverhalten des Refactors prüft
- Block 7:
  - `lib/IngestStates/admin-ui/dist/presets.esm.test.js` muss wieder grün sein
  - zusammen mit Lint, `node --check` und den übrigen betroffenen Tests

Damit bleibt die Governance-Regel "tests stay mandatory" erhalten, aber mit expliziter Zwischenblock-Ausnahme für den bereits vorhandenen Vollziel-Test der Bundle-Datei.

## Scope der übrigen Worktree-Dateien

Dieser Plan refactort ausschließlich:

- `lib/IngestStates/admin-ui/dist/presets.esm.js`

Folgende Dateien gehören ausdrücklich nicht zum inhaltlichen Refactor-Scope dieses Plans:

- `lib/IngestStates/admin-ui/dist/presets.esm.css`
- `lib/IngestStates/admin-ui/i18n/*.json`
- `lib/IngestStates/admin-ui/presets-service.js`
- `lib/IngestStates/admin-ui/presets-service.test.js`
- `lib/IngestStates/admin-ui/rpc.js`
- `lib/IngestStates/admin-ui/rpc.test.js`

Für diese Dateien gilt in diesem Plan:

- sie werden während Block 1 bis Block 6 nicht inhaltlich weiter verändert
- sie bleiben als bereits vorhandene, separate Arbeit im Worktree bestehen
- ihre Commit-Entscheidung ist nicht Teil dieses Refactor-Plans

Block 7 meint deshalb nur den commitbaren Zielzustand des Refactor-Scopes für `presets.esm.js` selbst. Er fordert nicht, dass alle übrigen bereits vorhandenen Worktree-Dateien in diesem Plan mitentschieden werden.

## Arbeitsmethode

1. `lib/IngestStates/admin-ui/dist/presets.esm.js.bak` bleibt rein temporäre Read-only-Referenz.
2. `lib/IngestStates/admin-ui/dist/presets.esm.js` wird als neue Arbeitsdatei von leer neu aufgebaut.
3. Der Zuschnitt erfolgt im selben File über klar abgegrenzte Factories.
4. Es werden keine "fliegenden" top-level Helper-Funktionen akzeptiert.

Verbindliche Schnittregel:

- Auf Modulebene sind nur erlaubt:
  - Dateiheader
  - `export async function mount(ctx)`
  - `export async function unmount(ctx)`
- Alle weiteren Helfer und Factories leben innerhalb des `mount(ctx)`-Scopes oder innerhalb genau der Factory, der sie fachlich gehören.
- Kein neuer globaler oder moduleweiter Helper-Teppich.

## Ziel-Schnitt im File

Die neue `presets.esm.js` soll im Endzustand aus klar getrennten, aber im selben File liegenden Blöcken bestehen:

1. `mount(ctx)`
   - einziger Einstieg
   - richtet lokale Factories ein
   - orchestriert Aufbau und Render

2. `createPanelRuntime(...)`
   - nur Host-Zugriff, RPC-Zugriff und i18n-Zugriff
   - keine Listen- oder Editorlogik

`loadBootstrapModel(...)` bleibt als Orchestrations-Helfer innerhalb von `mount(ctx)` und gehört nicht zur Verantwortung von `createPanelRuntime(...)`.

3. `createPresetsState(...)`
   - nur lokaler Editor-/Listen-State
   - kein DOM-Bau

4. `createListPane(...)`
   - Toolbar
   - Laden/Reload
   - Auswahl
   - Listenrendering

5. `createEditorPane(...)`
   - rechter Bereich
   - Sections
   - Builtin-/Readonly-Anzeige

6. `createFieldFactory(...)`
   - Feldrendering für Text, Textarea, Select, CSV, JSON, Checkbox, Timing
   - nur feldnahe Helfer, keine Listen- oder Save-Logik

7. `createEditorActions(...)`
   - create / duplicate / save / delete / discard
   - nutzt State + Runtime + Pane-APIs

Der Schnitt ist fachlich, nicht technisch-generisch. Es werden keine "Utility-Sammlungen" ohne klaren Besitzer gebaut.

## Block-Reihenfolge

### Block 1: File Reset + leeres Grundgerüst

Inhalt:

- `presets.esm.js` auf wirklich minimales Grundgerüst setzen
- nur Dateiheader, `mount(ctx)`, `unmount(ctx)`
- keine fliegenden Helper
- `.bak` bleibt unverändert daneben

Review-Ziel:

- bestätigt, dass der Neubau wirklich von leer startet
- bestätigt, dass die unerwünschten top-level Helper verschwunden sind

### Block 2: Runtime- und Bootstrap-Block

Inhalt:

- innerhalb von `mount(ctx)` nur der Runtime-/Bootstrap-Schnitt
- Host-Validierung
- RPC-Fassade
- Bootstrap laden
- i18n-/Host-Zugriffe verdrahten
- noch keine Listen- oder Editor-UI

Review-Ziel:

- sauberer Schnitt zwischen Host/RPC und späterer UI
- keine Layer-Verstöße

### Block 3: List-Factory

Inhalt:

- `createListPane(...)`
- Toolbar-Grundstruktur
- Listen-Laden/Reload
- Selektion
- Leerzustand
- Spinner-/Toast-Pfad wie vereinbart

Review-Ziel:

- Liste ist isoliert verständlich
- kein Rückfall in Monolith-Logik

### Block 4: State- und Field-Factory

Inhalt:

- `createPresetsState(...)`
- `createFieldFactory(...)`
- Draft-/CSV-/JSON-/Timing-nahe Feldlogik
- noch kein vollständiger Editor-Render

Review-Ziel:

- feldnahe Logik ist aus Liste und Actions getrennt
- keine fliegenden Utility-Blöcke

### Block 5: Editor-Factory

Inhalt:

- `createEditorPane(...)`
- Sections
- Builtin-/Readonly-Hinweis
- sichtbare Feldstruktur

Review-Ziel:

- rechter Bereich ist fachlich vom Rest getrennt
- DOM-Struktur bleibt nah am bisherigen Port

### Block 6: Actions-Factory + Endintegration

Inhalt:

- `createEditorActions(...)`
- save / create / duplicate / delete / discard
- endgültige Verdrahtung von Liste + Editor + State
- `root.__msghubReady` wird am Ende der vollständigen Initialisierung in `mount(ctx)` gesetzt

Review-Ziel:

- keine Restkopplungen quer durch das File
- verständliche Orchestrierung in `mount(ctx)`
- `await ctx.root.__msghubReady` ist nach vollständiger Initialisierung wieder korrekt verwendbar

### Block 7: Abschluss

Inhalt:

- Check/Lint/Tests
- `.bak` entfernen
- Restprüfung auf offene Hardcodes und Commit-Reste

Review-Ziel:

- nur noch ein commitbarer Zielzustand im Worktree

## Explizit nicht erlaubt

- top-level `cloneJson`, `parseCsvList`, `formatCsvList` oder ähnliche freie Helper
- top-level "Bridge"-Hilfen ohne klaren Factory-Besitzer
- funktionale Änderungen unter dem Vorwand eines Refactors
- "bei der Gelegenheit" neue Validierung, neue i18n-Keys, neue UX oder neue Datenflüsse
- heimliche Mitnahme zusätzlicher Refactors
- nach einem Block ohne Review direkt in den nächsten Block springen

## Erfolgskriterium

Der Refactor ist nur dann erfolgreich, wenn am Ende gleichzeitig gilt:

1. fachliches Verhalten des Presets-Panels ist identisch zum Startzustand dieses Refactors
2. keine unkontrollierten top-level Helper im File
3. interner Zuschnitt ist anhand der Factories verständlich
4. `.bak` ist wieder entfernt
5. keine neue Architektur eingeführt
6. keine funktionale Abweichung wurde eingebaut
