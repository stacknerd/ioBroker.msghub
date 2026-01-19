'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

function readJson(relPath) {
	return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf8'));
}

function readText(relPath) {
	return fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf8');
}

function extractUiKeys(jsonCustom) {
	const keys = [];

	for (const tab of Object.values(jsonCustom?.items || {})) {
		const items = tab?.items || {};
		for (const key of Object.keys(items)) {
			if (key.startsWith('_')) {
				continue;
			}
			keys.push(key);
		}
	}

	return keys.sort();
}

function consumerForKey(key) {
	if (key === 'mode') {
		return { file: 'lib/IngestStates/Engine.js', prop: 'mode' };
	}

	if (key === 'msg-DefaultId' || key === 'msg-SessionStartId') {
		return { file: 'lib/IngestStates/Engine.js', prop: key };
	}

	const idx = key.indexOf('-');
	if (idx <= 0) {
		return null;
	}

	const prefix = key.slice(0, idx);
	const prop = key.slice(idx + 1);
	if (prefix === 'thr') {
		return { file: 'lib/IngestStates/rules/Threshold.js', prop };
	}
	if (prefix === 'fresh') {
		return { file: 'lib/IngestStates/rules/Freshness.js', prop };
	}
	if (prefix === 'trg') {
		return { file: 'lib/IngestStates/rules/Triggered.js', prop };
	}
	if (prefix === 'nonset') {
		return { file: 'lib/IngestStates/rules/NonSettling.js', prop };
	}
	if (prefix === 'sess') {
		return { file: 'lib/IngestStates/rules/Session.js', prop };
	}
	if (prefix === 'msg') {
		return { file: 'lib/IngestStates/MessageWriter.js', prop };
	}
	if (prefix === 'managedMeta') {
		// managed-meta fields are stored as flat keys and are used as string keys in IoManagedMeta
		return { file: 'lib/IoManagedMeta.js', prop: key };
	}

	return null;
}

function hasPropUsage(source, prop) {
	// Prefer a somewhat specific match to avoid false positives in random text:
	// - `.prop`, `?.prop`, `['prop']`, `"prop"` (for dynamic key access)
	const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(`(?:\\?\\.|\\.)${escaped}\\b|\\[['"]${escaped}['"]\\]|['"]${escaped}['"]`, 'u');
	return re.test(source);
}

describe('IngestStates jsonCustom coverage', () => {
	it('wires all non-underscore jsonCustom keys in code', () => {
		const jsonCustom = readJson('admin/jsonCustom.json');
		const keys = extractUiKeys(jsonCustom);
		expect(keys).to.have.length.greaterThan(0);

		const failures = [];

		for (const key of keys) {
			const consumer = consumerForKey(key);
			if (!consumer) {
				failures.push({ key, reason: 'no consumer mapping' });
				continue;
			}

			const source = readText(consumer.file);
			if (!hasPropUsage(source, consumer.prop)) {
				failures.push({ key, reason: `prop '${consumer.prop}' not found in ${consumer.file}` });
			}
		}

		expect(
			failures,
			failures.map(f => `${f.key}: ${f.reason}`).join('\n'),
		).to.deep.equal([]);
	});
});
