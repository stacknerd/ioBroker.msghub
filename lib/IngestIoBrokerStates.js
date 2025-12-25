/**
 * ioBroker States Ingest (Konzept) – Custom-Datenstruktur pro Objekt
 *
 * Diese Konfiguration wird pro ioBroker-Objekt im Custom gespeichert, wenn du im Admin unter
 * „Objekte → Custom“ die msghub-Überwachung aktivierst und konfigurierst.
 *
 * Speicherort (pro Objekt):
 *   obj.common.custom['msghub.<instanz>'] = MsghubCustomConfig
 * Beispiel:
 *   obj.common.custom['msghub.0']
 *
 * Wichtige Hinweise:
 * - ioBroker verwaltet das Flag `enabled` selbst (Custom an/aus).
 * - jsonConfig speichert Pfade mit Punkten i. d. R. als verschachtelte Objekte (z. B. `fresh.everyValue`
 *   wird zu `{ fresh: { everyValue: ... } }`). In manchen Setups können auch „flache“ Keys vorkommen
 *   (z. B. `{ 'fresh.everyValue': ... }`). Die UI-Schema-Logik im Projekt ist darauf vorbereitet,
 *   beide Varianten zu lesen.
 * - Zeiteinheiten werden in der aktuellen UI als Sekunden-Multiplikatoren gespeichert (Zahlen),
 *   nicht als Strings wie "min"/"h"/"d".
 *     - 1     = Sekunde
 *     - 60    = Minute
 *     - 3600  = Stunde
 *     - 86400 = Tag
 *
 * ---------------------------------------------------------------------------
 * MsghubCustomConfig (normalisierte Struktur)
 * ---------------------------------------------------------------------------
 *
 * @typedef {Object} MsghubCustomConfig
 * @property {boolean} enabled
 *   Wird von ioBroker gesetzt: Custom für dieses Objekt aktiv.
 *
 * @property {Object} [meta]
 * @property {string} [meta.managedBy]
 *   Wenn gesetzt, wird dieses Objekt von einer höher priorisierten Quelle verwaltet
 *   (manuelle Regeln ggf. deaktiviert/ausgeblendet).
 * @property {string} [meta.managedSince]
 *   Zeit/Info, seit wann verwaltet (Darstellungstext; Format ist Quelle/Implementierung).
 * @property {string} [meta.managedText]
 *   Freitext-Hinweis der Quelle (nur Anzeige; keine Logik).
 *
 * @property {'threshold'|'freshness'|'triggered'|'nonSettling'|'session'} [mode]
 *   Welcher Regeltyp für dieses Objekt aktiv ist (entspricht der Auswahl im Panel „Überwachung“).
 *
 * @property {FreshnessRule} [fresh]
 * @property {TriggeredRule} [trg]
 * @property {NonSettlingRule} [ns]
 * @property {SessionRule} [sess]
 * @property {ThresholdRule} [thr]
 * @property {MessageConfig} [msg]
 * @property {Object} [expert]
 *   Reserviert (UI aktuell ohne Eingaben).
 */

/**
 * ---------------------------------------------------------------------------
 * Regel 1 – Aktualisierungsintervall (Freshness/Heartbeat)
 * ---------------------------------------------------------------------------
 *
 * Zweck:
 * - Meldet, wenn ein Datenpunkt „zu lange“ kein Update (oder keine echte Änderung) hatte.
 *
 * @typedef {Object} FreshnessRule
 * @property {number} [everyValue]
 *   Maximaler Abstand zwischen Updates/Änderungen.
 * @property {number} [everyUnit]
 *   Sekunden-Multiplikator (z. B. 60/3600/86400).
 * @property {'ts'|'lc'} [evaluateBy]
 *   Zeitstempel für die Auswertung:
 *   - ts: last update (auch bei gleichen Werten)
 *   - lc: last change (nur bei echten Wertänderungen)
 *
 * Beispiel:
 * {
 *   mode: 'freshness',
 *   fresh: { everyValue: 12, everyUnit: 3600, evaluateBy: 'lc' }
 * }
 */

/**
 * ---------------------------------------------------------------------------
 * Regel 2 – Abhängigkeit (Trigger → Reaktion)
 * ---------------------------------------------------------------------------
 *
 * Zweck:
 * - Wenn Trigger A aktiv wird, muss Ziel B innerhalb eines Zeitfensters reagieren.
 *
 * @typedef {Object} TriggeredRule
 * @property {string} [id]
 *   Objekt-ID des Trigger-States.
 * @property {'eq'|'neq'|'gt'|'lt'|'truthy'|'falsy'} [operator]
 *   Vergleichsoperator für den Trigger.
 * @property {'boolean'|'number'|'string'} [valueType]
 *   Datentyp des Vergleichswerts (bei truthy/falsy i. d. R. nicht nötig).
 * @property {boolean} [valueBool]
 *   Vergleichswert für boolean.
 * @property {number} [valueNumber]
 *   Vergleichswert für number.
 * @property {string} [valueString]
 *   Vergleichswert für string.
 *
 * @property {number} [windowValue]
 *   Zeitfenster-Länge.
 * @property {number} [windowUnit]
 *   Sekunden-Multiplikator (1/60/3600).
 *
 * @property {'changed'|'deltaUp'|'deltaDown'|'thresholdGte'|'thresholdLte'} [expectation]
 *   Erwartete Reaktion dieses Objekts innerhalb des Fensters:
 *   - changed: Wert ändert sich (mind. ein Update/Change)
 *   - deltaUp/deltaDown: Wert ändert sich um mindestens minDelta in die Richtung
 *   - thresholdGte/thresholdLte: Wert erreicht/unterbietet threshold
 * @property {number} [minDelta]
 *   Mindest-Delta für deltaUp/deltaDown.
 * @property {number} [threshold]
 *   Schwellwert für thresholdGte/thresholdLte.
 *
 * Beispiele:
 * - Ventil (Trigger) EIN → Wasserzähler muss innerhalb 10 Minuten um mind. 1 steigen
 * - Steckdose (Trigger) EIN → Leistung muss innerhalb 30 Sekunden >= 5 W sein
 */

/**
 * ---------------------------------------------------------------------------
 * Regel 3 – Unruhiger Wert (Non-settling / Anomalie)
 * ---------------------------------------------------------------------------
 *
 * Zweck:
 * - Erkennt Daueraktivität („kommt nicht zur Ruhe“) oder einen auffälligen Trend (Leckage).
 *
 * @typedef {Object} NonSettlingRule
 * @property {'activity'|'trend'} [profile]
 *   - activity: Meldet, wenn über lange Zeit keine Ruhephase erreicht wird
 *   - trend: Meldet, wenn der Wert über ein Fenster in eine Richtung läuft
 * @property {number} [minDelta]
 *   Ignoriert kleine Änderungen/Messrauschen (0 = jede Änderung zählt).
 *
 * Activity-Profil:
 * @property {number} [maxContinuousValue]
 * @property {number} [maxContinuousUnit]  Sekunden-Multiplikator (60/3600)
 * @property {number} [quietGapValue]
 * @property {number} [quietGapUnit]       Sekunden-Multiplikator (60/3600)
 *
 * Trend-Profil:
 * @property {'up'|'down'|'any'} [direction]
 * @property {number} [trendWindowValue]
 * @property {number} [trendWindowUnit]    Sekunden-Multiplikator (3600/86400)
 * @property {number} [minTotalDelta]
 *   Optional: Mindest-Gesamtänderung im Fenster (0 = egal).
 *
 * Beispiele:
 * - Wasserzähler steigt 12 Stunden lang → mögliche Leckage (profile: 'trend', direction: 'up')
 * - Sensor „flattert“ ohne Ruhephase → activity + quietGap
 */

/**
 * ---------------------------------------------------------------------------
 * Regel 4 – Session (Start/Stop)
 * ---------------------------------------------------------------------------
 *
 * Zweck:
 * - Erkennt, wann ein Prozess startet und endet (typisch über Leistungsschwellen).
 * - Optional mit Energiezähler + Preis für eine Zusammenfassung am Ende.
 *
 * @typedef {Object} SessionRule
 * @property {string} [onOffId]
 *   Optional: Gate-State (z. B. Schalter EIN). Wenn gesetzt, wird nur bei aktivem Gate ausgewertet.
 * @property {'truthy'|'falsy'|'eq'} [onOffActive]
 * @property {string} [onOffValue]
 *
 * Start:
 * @property {number} [startThreshold]        Leistung (W) für Start.
 * @property {number} [startMinHoldValue]     Mindestdauer über Start-Schwelle (0 = sofort).
 * @property {number} [startMinHoldUnit]      Sekunden-Multiplikator (1/60).
 *
 * Stop/Fertig:
 * @property {number} [stopThreshold]         Leistung (W) für Stop/Standby.
 * @property {number} [stopDelayValue]        „Fertig nach“ unter Stop-Schwelle.
 * @property {number} [stopDelayUnit]         Sekunden-Multiplikator (1/60/3600).
 * @property {boolean} [cancelStopIfAboveStopThreshold]
 *   true: Fertig-Timer abbrechen, wenn die Leistung wieder steigt.
 *
 * Optionaler Abschluss:
 * @property {string} [energyCounterId]        Objekt-ID eines Energiezählers (kWh).
 * @property {string} [pricePerKwhId]          Objekt-ID eines Preises (€/kWh).
 * @property {number} [roundDigits]           Rundung für kWh/€ in der Ausgabe.
 *
 * Beispiel (E‑Auto laden):
 * {
 *   mode: 'session',
 *   sess: { startThreshold: 50, stopThreshold: 15, stopDelayValue: 5, stopDelayUnit: 60 }
 * }
 */

/**
 * ---------------------------------------------------------------------------
 * Regel 5 – Schwellenwert
 * ---------------------------------------------------------------------------
 *
 * Zweck:
 * - Warnen, wenn ein Zahlenwert unter/über einem Grenzwert liegt oder einen Bereich verlässt.
 *
 * @typedef {Object} ThresholdRule
 * @property {'lt'|'gt'|'outside'|'inside'|'truthy'|'falsy'} [mode]
 *   Vergleichsmodus.
 * @property {number} [value]
 *   Grenzwert für lt/gt.
 * @property {number} [min]
 * @property {number} [max]
 *   Bereichswerte für inside/outside.
 *
 * Stabilisierung:
 * @property {number} [hysteresis]
 *   Rückkehrband gegen Flattern (0 = aus).
 * @property {number} [minDurationValue]
 * @property {number} [minDurationUnit]  Sekunden-Multiplikator (1/60/3600)
 *   Bedingung muss so lange gelten, bevor gemeldet wird (0 = sofort).
 *
 * Boolean-Checks:
 * - Mit `mode: 'truthy'|'falsy'` kann auch ein Boolean über Zeit überwacht werden.
 *   Beispiel: „Fensterkontakt ist 12h offen“ (je nach Gerät ist offen = true oder false).
 */

/**
 * ---------------------------------------------------------------------------
 * Meldung (msg.*) – gemeinsame Nachrichteneinstellungen
 * ---------------------------------------------------------------------------
 *
 * Diese Felder gelten unabhängig vom Regeltyp und steuern die erzeugte MsgHub-Meldung.
 *
 * @typedef {Object} MessageConfig
 * @property {0|10|20|30} [level]
 *   none=0, notice=10, warning=20, error=30
 * @property {''|'status'|'task'} [kind]
 *   Optionaler Typ (leer = automatisch).
 * @property {string} [title]
 * @property {string} [text]
 * @property {number} [cooldownValue]
 * @property {number} [cooldownUnit]
 *   Sekunden-Multiplikator (60/3600/86400). Unterdrückt Wiederholungen.
 * @property {number} [remindValue]
 * @property {number} [remindUnit]
 *   Sekunden-Multiplikator (1/60/3600/86400). Optional: regelmäßige Erinnerung (0 = aus).
 * @property {boolean} [resetOnNormal]
 *   true: Meldung automatisch schließen, wenn der Normalzustand zurückkehrt.
 *   false: Meldung bleibt bestehen und muss manuell bestätigt werden.
 * @property {number} [resetDelayValue]
 * @property {number} [resetDelayUnit]
 *   Sekunden-Multiplikator (1/60/3600/86400). Optional: Verzögerung, bevor beim Normalzustand entfernt wird.
 *
 * Session-spezifisch (nur wenn `mode: 'session'`):
 * @property {boolean} [sessionStartEnabled]
 * @property {''|'status'|'task'} [sessionStartKind]
 * @property {0|10|20|30} [sessionStartLevel]
 * @property {string} [sessionStartTitle]
 * @property {string} [sessionStartText]
 */

// Expert-Config ist aktuell reserviert; UI zeigt noch keine Eingaben.
