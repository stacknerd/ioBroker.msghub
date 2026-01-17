#!/usr/bin/env node
'use strict';

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

function isPlainObject(value) {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLang(lang) {
	return String(lang).trim().toLowerCase();
}

function stableSortStrings(list) {
	return list.slice().sort((a, b) => compareKeys(a, b));
}

function compareKeys(a, b) {
	const aa = String(a);
	const bb = String(b);
	const al = aa.toLowerCase();
	const bl = bb.toLowerCase();
	if (al < bl) return -1;
	if (al > bl) return 1;
	if (aa < bb) return -1;
	if (aa > bb) return 1;
	return 0;
}

async function listJsonFiles(dirPath) {
	let entries;
	try {
		entries = await fs.readdir(dirPath, { withFileTypes: true });
	} catch (e) {
		if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') {
			return [];
		}
		throw e;
	}
	return entries.filter(e => e.isFile() && e.name.endsWith('.json')).map(e => path.join(dirPath, e.name));
}

async function listLangFilesInDir(dirPath) {
	const files = await listJsonFiles(dirPath);
	return files.map(filePath => ({
		lang: normalizeLang(path.basename(filePath, '.json')),
		filePath,
	}));
}

async function readJsonObject(filePath) {
	const text = await fs.readFile(filePath, 'utf8');
	const json = JSON.parse(text);
	if (!isPlainObject(json)) {
		throw new Error(`Expected JSON object in ${filePath}`);
	}
	return json;
}

function collectKeys(json) {
	return Object.keys(json || {}).filter(k => typeof k === 'string' && k.trim());
}

function diffKeys(baseKeys, otherKeys) {
	const base = new Set(baseKeys);
	const other = new Set(otherKeys);

	const missing = [];
	const extra = [];
	for (const key of base) {
		if (!other.has(key)) {
			missing.push(key);
		}
	}
	for (const key of other) {
		if (!base.has(key)) {
			extra.push(key);
		}
	}
	return { missing: stableSortStrings(missing), extra: stableSortStrings(extra) };
}

function isSorted(keys) {
	for (let i = 1; i < keys.length; i += 1) {
		if (compareKeys(keys[i - 1], keys[i]) > 0) {
			return false;
		}
	}
	return true;
}

function resolveTargetDirs(scope) {
	const s = String(scope || 'all').toLowerCase();
	if (!['all', 'runtime', 'admin'].includes(s)) {
		throw new Error(`Invalid --scope "${scope}". Use all|runtime|admin.`);
	}
	const out = [];
	if (s === 'all' || s === 'runtime') {
		out.push('i18n');
	}
	if (s === 'all' || s === 'admin') {
		out.push(path.join('admin', 'i18n'));
	}
	return out;
}

const { values } = parseArgs({
	options: {
		scope: { type: 'string' },
		sort: { type: 'boolean' },
		help: { type: 'boolean' },
	},
});

if (values.help) {
	// eslint-disable-next-line no-console
	console.log(`Usage:
  node i18n-check.mjs [--scope all|runtime|admin] [--sort]

Checks:
  - All language files have the same keys as base (en).
  - Optional: key order is sorted (alphabetical, shallow) in every file.
`);
	process.exit(0);
}

const scope = values.scope ?? 'all';
const checkSort = Boolean(values.sort);

const dirs = resolveTargetDirs(scope);
if (!dirs.length) {
	throw new Error('No target dirs resolved.');
}

let ok = true;
for (const dir of dirs) {
	const name = dir === 'i18n' ? 'runtime' : 'admin';
	const targets = await listLangFilesInDir(dir);
	if (!targets.length) {
		// eslint-disable-next-line no-console
		console.log(`[${name}] dir=${dir}: no language files`);
		continue;
	}

	const en = targets.find(t => t.lang === 'en') || targets[0];
	const baseJson = await readJsonObject(en.filePath);
	const baseKeys = collectKeys(baseJson);

	// eslint-disable-next-line no-console
	console.log(`[${name}] dir=${dir} base=${en.lang} keys=${baseKeys.length}`);

	for (const t of targets) {
		const json = await readJsonObject(t.filePath);
		const keys = collectKeys(json);
		const diff = diffKeys(baseKeys, keys);

		const sortOk = !checkSort || isSorted(keys);
		const syncOk = diff.missing.length === 0 && diff.extra.length === 0;

		if (!syncOk || !sortOk) {
			ok = false;
		}

		// eslint-disable-next-line no-console
		console.log(
			`- ${t.lang}: missing=${diff.missing.length} extra=${diff.extra.length}${checkSort ? ` sorted=${sortOk}` : ''}`,
		);

		if (diff.missing.length) {
			for (const k of diff.missing.slice(0, 25)) {
				// eslint-disable-next-line no-console
				console.log(`  missing: ${JSON.stringify(k)}`);
			}
			if (diff.missing.length > 25) {
				// eslint-disable-next-line no-console
				console.log(`  missing: … (${diff.missing.length - 25} more)`);
			}
		}

		if (diff.extra.length) {
			for (const k of diff.extra.slice(0, 25)) {
				// eslint-disable-next-line no-console
				console.log(`  extra: ${JSON.stringify(k)}`);
			}
			if (diff.extra.length > 25) {
				// eslint-disable-next-line no-console
				console.log(`  extra: … (${diff.extra.length - 25} more)`);
			}
		}
	}
}

process.exit(ok ? 0 : 1);
