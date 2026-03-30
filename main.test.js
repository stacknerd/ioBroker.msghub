'use strict';

// Tests for lib/loadI18nDir and the _i18ninit wiring pattern in main.js.
//
// Tests cover:
//   - loadI18nDir() happy path (real i18n directories)
//   - loadI18nDir() error paths (missing dir, JSON parse error)
//   - _i18ninit() shape: i18nBackend / i18nCore carry t, getTranslatedObject, locale, i18nlocale
//   - _i18ninit() wiring invariants: _i18nRegistry set as IoRuntimeI18n with both sources
//   - Pass-through: _i18nRegistry produced by wiring is the same object stored in IoPlugins
//   - Live-binding (A8): translator created before second addSource sees new keys
//
// System: main.test.js
// Depends on: lib/loadI18nDir.js, lib/IoRuntimeI18n.js, lib/IoPlugins.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const { expect } = require('chai');

const { loadI18nDir, LANGS } = require('./lib/loadI18nDir');
const { IoRuntimeI18n } = require('./lib/IoRuntimeI18n');
const { IoPlugins } = require('./lib/IoPlugins');

// ---------------------------------------------------------------------------
// Minimal adapter stub — enough for IoPlugins construction (no ioBroker lifecycle).
// Methods are no-ops; they are not called during construction.
// ---------------------------------------------------------------------------

/**
 * Builds a minimal adapter stub sufficient for IoPlugins constructor.
 *
 * @returns {object} Adapter stub.
 */
function makeStubAdapter() {
	return {
		namespace: 'msghub.0',
		log: { debug() {}, info() {}, warn() {}, error() {} },
		i18n: { t: (/** @type {string} */ s) => s, getTranslatedObject: (/** @type {string} */ s) => ({ en: s }) },
		subscribeStates: () => {},
		subscribeForeignStates: () => {},
		getObjectAsync: async () => null,
		setObjectNotExistsAsync: async () => {},
		extendObjectAsync: async () => {},
		extendForeignObjectAsync: async () => {},
		getForeignObjectAsync: async () => null,
		getForeignStateAsync: async () => null,
		getStateAsync: async () => null,
		setStateAsync: async () => {},
		delObjectAsync: async () => {},
	};
}

/**
 * Builds a minimal msgStore stub sufficient for IoPlugins constructor.
 *
 * @returns {object} MsgStore stub.
 */
function makeStubStore() {
	return {
		msgIngest: { registerPlugin: () => {}, unregisterPlugin: () => {} },
		msgNotify: { registerPlugin: () => {}, unregisterPlugin: () => {} },
	};
}

// ---------------------------------------------------------------------------
// Paths to real i18n directories
// ---------------------------------------------------------------------------

const CORE_DIR = path.join(__dirname, 'i18n');
const OVERLAY_DIR = path.join(__dirname, 'lib/_generated/backend-i18n/root-admin');

// ---------------------------------------------------------------------------
// loadI18nDir — happy path
// ---------------------------------------------------------------------------

describe('loadI18nDir — happy path', () => {
	it('loads core-runtime dir and returns wordsByLang with all expected langs', () => {
		const wordsByLang = loadI18nDir(CORE_DIR);
		expect(wordsByLang).to.have.property('en');
		for (const lang of LANGS) {
			expect(wordsByLang).to.have.property(lang);
		}
	});

	it('wordsByLang[lang] is a plain object with string values', () => {
		const wordsByLang = loadI18nDir(CORE_DIR);
		const en = wordsByLang['en'];
		expect(en).to.be.an('object');
		// Spot-check a known core key.
		expect(en['msghub.i18n.core.common.MsgConstants.kind.appointment.label']).to.equal('Appointment');
	});

	it('loads overlay dir and returns all keys from admin/i18n/', () => {
		const wordsByLang = loadI18nDir(OVERLAY_DIR);
		expect(wordsByLang).to.have.property('en');
		// Spot-check a known overlay key.
		expect(wordsByLang['en']['msghub.i18n.core.admin.common.action.ack.label']).to.equal(
			'stop notifying (acknowledge)',
		);
	});
});

// ---------------------------------------------------------------------------
// loadI18nDir — error paths
// ---------------------------------------------------------------------------

describe('loadI18nDir — error paths', () => {
	it('throws with path info when directory does not exist', () => {
		const missing = path.join(__dirname, 'nonexistent-i18n-dir-xyz');
		expect(() => loadI18nDir(missing)).to.throw(/Backend i18n dir not found/);
		expect(() => loadI18nDir(missing)).to.throw(missing);
	});

	it('throws with file info on JSON parse error', () => {
		// Create a temp directory with an invalid en.json so require() throws a parse error.
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msghub-i18n-test-'));
		const badFile = path.join(tmpDir, 'en.json');
		try {
			fs.writeFileSync(badFile, 'NOT VALID JSON { broken', 'utf8');
			expect(() => loadI18nDir(tmpDir)).to.throw(/JSON parse error/);
			expect(() => loadI18nDir(tmpDir)).to.throw('en.json');
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// _i18ninit() shape — integration without adapter lifecycle
// ---------------------------------------------------------------------------

describe('_i18ninit shape (integration)', () => {
	it('i18nBackend has t, getTranslatedObject, locale, i18nlocale', () => {
		const registry = new IoRuntimeI18n();
		registry.addSource('core-runtime', 'core-runtime', loadI18nDir(CORE_DIR));
		registry.addSource('root-admin-overlay', 'root-admin-overlay', loadI18nDir(OVERLAY_DIR));

		const i18nBackend = Object.freeze({
			...registry.createTranslator('en'),
			locale: 'de-DE',
			i18nlocale: 'en',
		});

		expect(i18nBackend.t).to.be.a('function');
		expect(i18nBackend.getTranslatedObject).to.be.a('function');
		expect(i18nBackend.locale).to.equal('de-DE');
		expect(i18nBackend.i18nlocale).to.equal('en');
	});

	it('i18nBackend.t() resolves overlay key correctly', () => {
		const registry = new IoRuntimeI18n();
		registry.addSource('core-runtime', 'core-runtime', loadI18nDir(CORE_DIR));
		registry.addSource('root-admin-overlay', 'root-admin-overlay', loadI18nDir(OVERLAY_DIR));

		const { t } = registry.createTranslator('en');
		expect(t('msghub.i18n.core.admin.common.action.ack.label')).to.equal('stop notifying (acknowledge)');
	});

	it('i18nCore.t() resolves core-runtime key correctly', () => {
		const registry = new IoRuntimeI18n();
		registry.addSource('core-runtime', 'core-runtime', loadI18nDir(CORE_DIR));
		registry.addSource('root-admin-overlay', 'root-admin-overlay', loadI18nDir(OVERLAY_DIR));

		const { t } = registry.createTranslator('en');
		expect(t('msghub.i18n.core.common.MsgConstants.kind.appointment.label')).to.equal('Appointment');
	});
});

// ---------------------------------------------------------------------------
// _i18ninit() wiring invariants
//
// These tests replicate the exact operations that _i18ninit() performs on a
// stub object, then assert the invariants that _i18ninit() is required to
// establish. Msghub is not directly exported, so the wiring is exercised by
// calling the same code path against a plain stub context.
// ---------------------------------------------------------------------------

describe('_i18ninit() wiring invariants', () => {
	it('_i18nRegistry is an IoRuntimeI18n instance with both source IDs after wiring', () => {
		// Object.create(null) → typed as any; avoids TypeScript narrowing stub fields to null.
		const stub = Object.create(null);
		stub.log = { debug() {}, warn() {} };

		// Exact operations performed by _i18ninit():
		const registry = new IoRuntimeI18n({ log: stub.log });
		registry.addSource('core-runtime', 'core-runtime', loadI18nDir(CORE_DIR, stub.log));
		registry.addSource(
			'root-admin-overlay',
			'root-admin-overlay',
			loadI18nDir(OVERLAY_DIR, stub.log),
		);
		stub._i18nRegistry = registry;

		expect(stub._i18nRegistry).to.be.instanceOf(IoRuntimeI18n);
		expect(stub._i18nRegistry.getSourceIds()).to.deep.equal(['core-runtime', 'root-admin-overlay']);
	});

	it('i18nBackend and i18nCore are frozen objects with the required shape', () => {
		const stub = Object.create(null);
		stub.log = { debug() {}, warn() {} };
		const general = {
			coreFormatLocale: 'de-DE',
			coreTextLanguage: 'de',
			backendTextLanguage: 'en',
		};

		const registry = new IoRuntimeI18n({ log: stub.log });
		registry.addSource('core-runtime', 'core-runtime', loadI18nDir(CORE_DIR, stub.log));
		registry.addSource(
			'root-admin-overlay',
			'root-admin-overlay',
			loadI18nDir(OVERLAY_DIR, stub.log),
		);
		stub._i18nRegistry = registry;
		stub.i18nBackend = Object.freeze({
			...registry.createTranslator(general.backendTextLanguage || 'en'),
			locale: general.coreFormatLocale,
			i18nlocale: general.backendTextLanguage,
		});
		stub.i18nCore = Object.freeze({
			...registry.createTranslator(general.coreTextLanguage || 'en'),
			locale: general.coreFormatLocale,
			i18nlocale: general.coreTextLanguage,
		});

		expect(Object.isFrozen(stub.i18nBackend)).to.equal(true);
		expect(Object.isFrozen(stub.i18nCore)).to.equal(true);
		expect(stub.i18nBackend.locale).to.equal('de-DE');
		expect(stub.i18nBackend.i18nlocale).to.equal('en');
		expect(stub.i18nCore.locale).to.equal('de-DE');
		expect(stub.i18nCore.i18nlocale).to.equal('de');
	});

	it('i18nBackend and i18nCore resolve translations in their respective languages', () => {
		const stub = Object.create(null);
		stub.log = { debug() {}, warn() {} };
		// backendTextLanguage: 'en', coreTextLanguage: 'de' — intentionally different.
		const general = { coreFormatLocale: 'de-DE', coreTextLanguage: 'de', backendTextLanguage: 'en' };

		const registry = new IoRuntimeI18n({ log: stub.log });
		registry.addSource('core-runtime', 'core-runtime', loadI18nDir(CORE_DIR, stub.log));
		registry.addSource(
			'root-admin-overlay',
			'root-admin-overlay',
			loadI18nDir(OVERLAY_DIR, stub.log),
		);
		stub._i18nRegistry = registry;
		stub.i18nBackend = Object.freeze({
			...registry.createTranslator(general.backendTextLanguage || 'en'),
			locale: general.coreFormatLocale,
			i18nlocale: general.backendTextLanguage,
		});
		stub.i18nCore = Object.freeze({
			...registry.createTranslator(general.coreTextLanguage || 'en'),
			locale: general.coreFormatLocale,
			i18nlocale: general.coreTextLanguage,
		});

		// i18nBackend uses 'en' → English translation.
		const coreKey = 'msghub.i18n.core.common.MsgConstants.kind.appointment.label';
		expect(stub.i18nBackend.t(coreKey)).to.equal('Appointment');
		// i18nCore uses 'de' → German translation (different language, same registry).
		expect(stub.i18nCore.t(coreKey)).to.be.a('string');
		expect(stub.i18nCore.t(coreKey)).to.not.equal(coreKey); // resolved, not fallen back to key
	});
});

// ---------------------------------------------------------------------------
// Pass-through: _i18nRegistry → IoPlugins (regression for main.js:200)
//
// Verifies that the IoRuntimeI18n instance produced by _i18ninit() wiring is
// the exact same object that IoPlugins stores when passed via options —
// covering the pass-through at:
//   this._msgPlugins = await IoPlugins.create(this, this.msgStore, { i18nRegistry: this._i18nRegistry });
// ---------------------------------------------------------------------------

describe('_i18nRegistry pass-through to IoPlugins', () => {
	it('IoPlugins stores the exact IoRuntimeI18n instance produced by _i18ninit() wiring', () => {
		const stub = Object.create(null);
		stub.log = { debug() {}, warn() {} };

		// Step 1 — replicate _i18ninit(): create registry, add both sources, assign to stub.
		const registry = new IoRuntimeI18n({ log: stub.log });
		registry.addSource('core-runtime', 'core-runtime', loadI18nDir(CORE_DIR, stub.log));
		registry.addSource(
			'root-admin-overlay',
			'root-admin-overlay',
			loadI18nDir(OVERLAY_DIR, stub.log),
		);
		stub._i18nRegistry = registry;

		// Step 2 — pass stub._i18nRegistry to IoPlugins (mirrors main.js:200).
		const mgr = new IoPlugins(makeStubAdapter(), makeStubStore(), {
			catalog: {},
			i18nRegistry: stub._i18nRegistry,
		});

		// Step 3 — IoPlugins stores the exact same instance (identity, not just equality).
		expect(mgr._i18nRegistry).to.equal(stub._i18nRegistry);
		expect(mgr._i18nRegistry).to.be.instanceOf(IoRuntimeI18n);
	});
});

// ---------------------------------------------------------------------------
// A8 live-binding — integration
// ---------------------------------------------------------------------------

describe('_i18ninit live-binding (A8 integration)', () => {
	it('translator created before addSource sees new overlay keys after addSource without recreation', () => {
		const registry = new IoRuntimeI18n();
		registry.addSource('core-runtime', 'core-runtime', loadI18nDir(CORE_DIR));

		// Create translator before overlay is added.
		const { t } = registry.createTranslator('en');

		// Use a synthetic key that is not present in the core-runtime source.
		// in i18n/, so real overlay files cannot demonstrate the "not yet visible" state.)
		const syntheticKey = 'msghub.i18n.core.admin._test.livebinding.sentinel';
		expect(t(syntheticKey)).to.equal(syntheticKey);

		// Add an overlay source with the synthetic key — same translator closure sees it immediately.
		registry.addSource('root-admin-overlay', 'root-admin-overlay', { en: { [syntheticKey]: 'Live value' } });
		expect(t(syntheticKey)).to.equal('Live value');
	});
});
