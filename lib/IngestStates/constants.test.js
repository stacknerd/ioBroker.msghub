'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { jsonCustomDefaults, presetSchema, presetTemplateV1, fallbackPresetId, createFallbackPreset } = require('./constants');

describe('IngestStates constants', () => {
	function collectJsonCustomFields({ ignoreManagedMeta = true } = {}) {
		const jsonCustom = require('../../admin/jsonCustom.json');
		const items = jsonCustom?.items || {};

		const fields = new Map();

		for (const tab of Object.values(items)) {
			const tabItems = tab?.items || {};
			for (const [key, field] of Object.entries(tabItems)) {
				if (key.startsWith('_')) {
					continue;
				}
				if (ignoreManagedMeta && key.startsWith('managedMeta-')) {
					continue;
				}
				fields.set(key, field);
			}
		}

		return fields;
	}

	function collectLeafPaths(value, prefix = '') {
		const paths = [];
		const isArray = Array.isArray(value);
		const isObject = !!value && typeof value === 'object' && !isArray;

		if (isArray) {
			paths.push(prefix);
			return paths;
		}

		if (!isObject) {
			paths.push(prefix);
			return paths;
		}

		const keys = Object.keys(value);
		if (!keys.length) {
			paths.push(prefix);
			return paths;
		}

		for (const key of keys) {
			const next = prefix ? `${prefix}.${key}` : key;
			paths.push(...collectLeafPaths(value[key], next));
		}

		return paths;
	}

	function collectEditorPresetPaths() {
		const file = path.join(__dirname, '..', '..', 'admin', 'tab.plugins.js');
		const source = fs.readFileSync(file, 'utf8');
		const paths = new Set();

		for (const match of source.matchAll(/updateMessageNested\(\s*['"]([^'"]+)['"]/g)) {
			const raw = match[1];
			if (raw) {
				paths.add(`message.${raw}`);
			}
		}

		for (const match of source.matchAll(/updateMessage\(\s*\{([\s\S]*?)\}\s*\)/g)) {
			const block = match[1] || '';
			for (const keyMatch of block.matchAll(/(?:^|[\n\r]|,)\s*([A-Za-z0-9_]+)\s*:/gm)) {
				const key = keyMatch[1];
				if (key) {
					paths.add(`message.${key}`);
				}
			}
		}

		for (const match of source.matchAll(/updatePolicy\(\s*\{([\s\S]*?)\}\s*\)/g)) {
			const block = match[1] || '';
			for (const keyMatch of block.matchAll(/(?:^|[\n\r]|,)\s*([A-Za-z0-9_]+)\s*:/gm)) {
				const key = keyMatch[1];
				if (key) {
					paths.add(`policy.${key}`);
				}
			}
		}

		for (const match of source.matchAll(/updateDraft\(\s*\{([\s\S]*?)\}\s*\)/g)) {
			const block = match[1] || '';
			for (const keyMatch of block.matchAll(/(?:^|[\n\r]|,)\s*([A-Za-z0-9_]+)\s*:/gm)) {
				const key = keyMatch[1];
				// `updateDraft({ message: ... })` / `updateDraft({ policy: ... })` are internal wrappers,
				// not editor-level fields, so we skip them here.
				if (key && key !== 'message' && key !== 'policy') {
					paths.add(key);
				}
			}
		}

		return paths;
	}

	it('exports stable schema identifiers', () => {
		expect(presetSchema).to.equal('msghub.IngestStatesMessagePreset.v1');
		expect(fallbackPresetId).to.equal('$fallback');
	});

	it('provides a frozen preset template', () => {
		expect(presetTemplateV1).to.be.an('object');
		expect(Object.isFrozen(presetTemplateV1)).to.equal(true);
		expect(presetTemplateV1.schema).to.equal(presetSchema);
	});

		it('creates an internal fallback preset (no iobroker state)', () => {
			const p = createFallbackPreset({ targetId: 'dev.0.x' });
			expect(p).to.be.an('object');
			expect(p.schema).to.equal(presetSchema);
			expect(p.presetId).to.equal(fallbackPresetId);
			expect(p.ownedBy).to.equal('internal');
			expect(p.message).to.be.an('object');
			expect(p.message.title).to.equal('Missing message preset');
			expect(p.message.text).to.include('dev.0.x');
		});

	it('jsonCustomDefaults matches admin/jsonCustom.json fields (ignoring managedMeta-*)', () => {
		const fields = collectJsonCustomFields({ ignoreManagedMeta: true });
		const uiKeys = Array.from(fields.keys()).sort();

		const defaults = jsonCustomDefaults;
		expect(defaults).to.be.an('object');
		expect(Object.isFrozen(defaults)).to.equal(true);

		const defaultKeys = Object.keys(defaults).sort();
		expect(defaultKeys).to.deep.equal(uiKeys);
	});

	it('jsonCustomDefaults matches jsonCustom default values where defined', () => {
		const fields = collectJsonCustomFields({ ignoreManagedMeta: true });

		for (const [key, field] of fields.entries()) {
			if (!Object.prototype.hasOwnProperty.call(field, 'default')) {
				continue;
			}

			expect(
				jsonCustomDefaults[key],
				`default mismatch for '${key}'`,
			).to.deep.equal(field.default);
		}
	});

	it('preset editor covers all preset template fields (no missed schema updates)', () => {
		const ignoredExact = new Set(['subset', 'ui']);
		const ignoredPrefix = ['ui.'];

		const allPaths = collectLeafPaths(presetTemplateV1);
		const filtered = allPaths.filter(p => {
			if (!p) {
				return false;
			}
			if (ignoredExact.has(p)) {
				return false;
			}
			for (const prefix of ignoredPrefix) {
				if (p.startsWith(prefix)) {
					return false;
				}
			}
			return true;
		});

		const editorPaths = collectEditorPresetPaths();

		const missing = filtered.filter(p => !editorPaths.has(p));
		const unexpected = Array.from(editorPaths).filter(p => !filtered.includes(p));

		expect(
			missing,
			`Missing fields in preset editor: ${missing.sort().join(', ')}`,
		).to.deep.equal([]);
		expect(
			unexpected,
			`Unexpected fields in preset editor: ${unexpected.sort().join(', ')}`,
		).to.deep.equal([]);
	});
});
