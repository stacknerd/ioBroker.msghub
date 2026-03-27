'use strict';

const { expect } = require('chai');

const { IoRuntimeI18n } = require('./IoRuntimeI18n');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal wordsByLang map for a single language and set of keys.
 *
 * @param {string} lang - Language code.
 * @param {Record<string, string>} keys - Key-to-translation mapping.
 * @returns {Record<string, Record<string, string>>}
 */
function words(lang, keys) {
	return { [lang]: keys };
}

/**
 * Creates a multi-language wordsByLang map.
 *
 * @param {Record<string, Record<string, string>>} map - Lang to key-translation map.
 * @returns {Record<string, Record<string, string>>}
 */
function multiWords(map) {
	return map;
}

/**
 * Creates a simple warn-capture logger.
 *
 * @returns {{ log: { warn(msg: string): void }, warnings: string[] }}
 */
function warnCapture() {
	const warnings = [];
	return { log: { warn: msg => warnings.push(msg) }, warnings };
}

// ---------------------------------------------------------------------------
// Happy Path
// ---------------------------------------------------------------------------

describe('IoRuntimeI18n — happy path', () => {
	it('single source: addSource + createTranslator → t() returns correct translation', () => {
		const registry = new IoRuntimeI18n();
		registry.addSource('core-runtime', 'core-runtime', words('en', { 'key.foo': 'Foo text' }));
		const { t } = registry.createTranslator('en');
		expect(t('key.foo')).to.equal('Foo text');
	});

	it('multi-source priority: root-admin-overlay wins over core-runtime at same key', () => {
		const { log, warnings } = warnCapture();
		const registry = new IoRuntimeI18n({ log });
		registry.addSource('core-runtime', 'core-runtime', words('en', { 'key.shared': 'core value' }));
		registry.addSource('root-admin-overlay', 'root-admin-overlay', words('en', { 'key.shared': 'admin value' }));
		const { t } = registry.createTranslator('en');
		expect(t('key.shared')).to.equal('admin value');
		expect(warnings).to.have.length(1);
		expect(warnings[0]).to.include('key.shared');
	});

	it('removeSource: key disappears on next t() call', () => {
		const registry = new IoRuntimeI18n();
		registry.addSource('core-runtime', 'core-runtime', words('en', { 'key.gone': 'Gone' }));
		const { t } = registry.createTranslator('en');
		expect(t('key.gone')).to.equal('Gone');
		registry.removeSource('core-runtime');
		expect(t('key.gone')).to.equal('key.gone'); // key string fallback
	});

	it('getTranslatedObject: returns all languages for a key', () => {
		const registry = new IoRuntimeI18n();
		registry.addSource(
			'core-runtime',
			'core-runtime',
			multiWords({ en: { 'key.multi': 'Hello' }, de: { 'key.multi': 'Hallo' } }),
		);
		const { getTranslatedObject } = registry.createTranslator('en');
		const result = getTranslatedObject('key.multi');
		expect(result).to.deep.equal({ en: 'Hello', de: 'Hallo' });
	});

	it('getTranslatedObject: applies %s substitution to all languages', () => {
		const registry = new IoRuntimeI18n();
		registry.addSource(
			'core-runtime',
			'core-runtime',
			multiWords({ en: { 'key.tmpl': 'Hello %s' }, de: { 'key.tmpl': 'Hallo %s' } }),
		);
		const { getTranslatedObject } = registry.createTranslator('en');
		const result = getTranslatedObject('key.tmpl', 'World');
		expect(result).to.deep.equal({ en: 'Hello World', de: 'Hallo World' });
	});
});

// ---------------------------------------------------------------------------
// A8 Closure-Binding
// ---------------------------------------------------------------------------

describe('IoRuntimeI18n — A8 closure-binding', () => {
	it('translator created before addSource sees new keys without recreating the facade', () => {
		const registry = new IoRuntimeI18n();
		// Create translator BEFORE any source is added.
		const { t } = registry.createTranslator('en');
		expect(t('key.late')).to.equal('key.late'); // not yet present

		// Add source AFTER creating the translator.
		registry.addSource('core-runtime', 'core-runtime', words('en', { 'key.late': 'Late value' }));

		// Same closure — no new createTranslator() call.
		expect(t('key.late')).to.equal('Late value');
	});
});

// ---------------------------------------------------------------------------
// Boundary
// ---------------------------------------------------------------------------

describe('IoRuntimeI18n — boundary', () => {
	it('empty wordsByLang does not throw', () => {
		const registry = new IoRuntimeI18n();
		expect(() => registry.addSource('core-runtime', 'core-runtime', {})).to.not.throw();
		const { t } = registry.createTranslator('en');
		expect(t('any.key')).to.equal('any.key');
	});

	it('unknown key returns the key string itself', () => {
		const registry = new IoRuntimeI18n();
		registry.addSource('core-runtime', 'core-runtime', words('en', { 'other.key': 'Other' }));
		const { t } = registry.createTranslator('en');
		expect(t('nonexistent.key')).to.equal('nonexistent.key');
	});

	it('unknown language in createTranslator falls back to en', () => {
		const registry = new IoRuntimeI18n();
		registry.addSource('core-runtime', 'core-runtime', words('en', { 'key.x': 'English text' }));
		const { t } = registry.createTranslator('xx'); // unknown lang
		expect(t('key.x')).to.equal('English text');
	});

	it('getTranslatedObject for unknown key returns { en: key }', () => {
		const registry = new IoRuntimeI18n();
		const { getTranslatedObject } = registry.createTranslator('en');
		expect(getTranslatedObject('nonexistent.key')).to.deep.equal({ en: 'nonexistent.key' });
	});

	it('t() applies %s substitution in order', () => {
		const registry = new IoRuntimeI18n();
		registry.addSource('core-runtime', 'core-runtime', words('en', { 'key.s': 'Hello %s and %s' }));
		const { t } = registry.createTranslator('en');
		expect(t('key.s', 'Alice', 'Bob')).to.equal('Hello Alice and Bob');
	});

	it('t() treats null args as the string "null"', () => {
		const registry = new IoRuntimeI18n();
		registry.addSource('core-runtime', 'core-runtime', words('en', { 'key.n': 'Value is %s' }));
		const { t } = registry.createTranslator('en');
		expect(t('key.n', null)).to.equal('Value is null');
	});
});

// ---------------------------------------------------------------------------
// Invalid input
// ---------------------------------------------------------------------------

describe('IoRuntimeI18n — invalid input', () => {
	it('addSource with unknown type throws', () => {
		const registry = new IoRuntimeI18n();
		expect(() => registry.addSource('x', 'unknown-type', {})).to.throw(/unknown source type/);
	});

	it('addSource with array wordsByLang throws', () => {
		const registry = new IoRuntimeI18n();
		expect(() => registry.addSource('x', 'core-runtime', [])).to.throw(/plain object/);
	});

	it('addSource with null wordsByLang throws', () => {
		const registry = new IoRuntimeI18n();
		expect(() => registry.addSource('x', 'core-runtime', null)).to.throw(/plain object/);
	});

	it('addSource with non-plain-object leaves state unchanged', () => {
		const registry = new IoRuntimeI18n();
		// Add a valid source first.
		registry.addSource('core-runtime', 'core-runtime', words('en', { 'key.ok': 'OK' }));
		// Attempt to add an invalid source.
		expect(() => registry.addSource('core-runtime', 'core-runtime', 'string')).to.throw(/plain object/);
		// Original source must still be present and functional.
		const { t } = registry.createTranslator('en');
		expect(t('key.ok')).to.equal('OK');
		expect(registry.getSourceIds()).to.deep.equal(['core-runtime']);
	});
});

// ---------------------------------------------------------------------------
// Error path
// ---------------------------------------------------------------------------

describe('IoRuntimeI18n — error path', () => {
	it('removeSource with unknown ID does not throw', () => {
		const registry = new IoRuntimeI18n();
		expect(() => registry.removeSource('nonexistent-id')).to.not.throw();
	});

	it('removeSource with unknown ID leaves existing sources intact', () => {
		const registry = new IoRuntimeI18n();
		registry.addSource('core-runtime', 'core-runtime', words('en', { 'key.x': 'X' }));
		registry.removeSource('nonexistent-id');
		const { t } = registry.createTranslator('en');
		expect(t('key.x')).to.equal('X');
	});
});

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

describe('IoRuntimeI18n — collision', () => {
	it('Layer 0/1: root-admin-overlay wins over core-runtime; warn is logged', () => {
		const { log, warnings } = warnCapture();
		const registry = new IoRuntimeI18n({ log });
		registry.addSource('core-runtime', 'core-runtime', words('en', { 'key.c': 'core' }));
		registry.addSource('root-admin-overlay', 'root-admin-overlay', words('en', { 'key.c': 'overlay' }));
		const { t } = registry.createTranslator('en');
		expect(t('key.c')).to.equal('overlay');
		expect(warnings).to.have.length(1);
	});

	it('Layer 2 same value: two plugin-runtime sources, same key, same value — no warn', () => {
		const { log, warnings } = warnCapture();
		const registry = new IoRuntimeI18n({ log });
		registry.addSource('plugin:Type:0', 'plugin-runtime', words('en', { 'plugin.key': 'same' }));
		registry.addSource('plugin:Type:1', 'plugin-runtime', words('en', { 'plugin.key': 'same' }));
		const { t } = registry.createTranslator('en');
		expect(t('plugin.key')).to.equal('same');
		expect(warnings).to.have.length(0);
	});

	it('Layer 2 different value: two plugin-runtime sources, same key, different value — warn; last-registered-wins', () => {
		const { log, warnings } = warnCapture();
		const registry = new IoRuntimeI18n({ log });
		registry.addSource('plugin:Type:0', 'plugin-runtime', words('en', { 'plugin.key': 'first' }));
		registry.addSource('plugin:Type:1', 'plugin-runtime', words('en', { 'plugin.key': 'second' }));
		const { t } = registry.createTranslator('en');
		expect(t('plugin.key')).to.equal('second'); // last-registered-wins
		expect(warnings).to.have.length(1);
		expect(warnings[0]).to.include('plugin.key');
	});
});

// ---------------------------------------------------------------------------
// API shape
// ---------------------------------------------------------------------------

describe('IoRuntimeI18n — API shape', () => {
	it('createTranslator returns exactly { t: Function, getTranslatedObject: Function }', () => {
		const registry = new IoRuntimeI18n();
		const translator = registry.createTranslator('en');
		expect(Object.keys(translator).sort()).to.deep.equal(['getTranslatedObject', 't']);
		expect(translator.t).to.be.a('function');
		expect(translator.getTranslatedObject).to.be.a('function');
	});
});

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

describe('IoRuntimeI18n — materialization', () => {
	it('_materialized is null after addSource (cache invalidated)', () => {
		const registry = new IoRuntimeI18n();
		registry.addSource('core-runtime', 'core-runtime', words('en', { 'key.m': 'M' }));
		expect(registry._materialized).to.be.null;
	});

	it('_materialized is built on first t() call and reused', () => {
		const registry = new IoRuntimeI18n();
		registry.addSource('core-runtime', 'core-runtime', words('en', { 'key.m': 'M' }));
		const { t } = registry.createTranslator('en');
		t('key.m');
		expect(registry._materialized).to.not.be.null;
		const ref = registry._materialized;
		t('key.m'); // second call reuses cache
		expect(registry._materialized).to.equal(ref);
	});

	it('_materialized is invalidated after addSource, then rebuilt on next t() call', () => {
		const registry = new IoRuntimeI18n();
		registry.addSource('core-runtime', 'core-runtime', words('en', { 'key.m': 'first' }));
		const { t } = registry.createTranslator('en');
		expect(t('key.m')).to.equal('first');
		expect(registry._materialized).to.not.be.null;

		registry.addSource('extra', 'root-admin-overlay', words('en', { 'key.new': 'new value' }));
		expect(registry._materialized).to.be.null; // invalidated

		expect(t('key.new')).to.equal('new value'); // triggers re-materialization
		expect(registry._materialized).to.not.be.null;
	});
});
