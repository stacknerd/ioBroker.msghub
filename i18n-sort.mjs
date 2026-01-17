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

function detectIndent(jsonText) {
	if (/\n\t"/.test(jsonText)) {
		return '\t';
	}
	return 2;
}

function detectEol(text) {
	return text.includes('\r\n') ? '\r\n' : '\n';
}

async function readJsonObjectWithStyle(filePath) {
	const text = await fs.readFile(filePath, 'utf8');
	const json = JSON.parse(text);
	if (!isPlainObject(json)) {
		throw new Error(`Expected JSON object in ${filePath}`);
	}
	return {
		text,
		json,
		indent: detectIndent(text),
		eol: detectEol(text),
		keys: Object.keys(json),
	};
}

function sameStringList(a, b) {
	if (a === b) {
		return true;
	}
	if (!Array.isArray(a) || !Array.isArray(b)) {
		return false;
	}
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

function sortObjectKeysShallow(json) {
	const keys = Object.keys(json);
	const sortedKeys = stableSortStrings(keys);
	if (sameStringList(keys, sortedKeys)) {
		return { changed: false, sorted: json, sortedKeys };
	}
	const sorted = Object.create(null);
	for (const key of sortedKeys) {
		sorted[key] = json[key];
	}
	return { changed: true, sorted, sortedKeys };
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
		help: { type: 'boolean' },
	},
});

if (values.help) {
	// eslint-disable-next-line no-console
	console.log(`Usage:
  node i18n-sort.mjs [--scope all|runtime|admin]

Sorts keys (shallow, alphabetical) in all i18n JSON files and rewrites files when needed.
`);
	process.exit(0);
}

const scope = values.scope ?? 'all';
const dirs = resolveTargetDirs(scope);

let changed = 0;
for (const dir of dirs) {
	const targets = await listLangFilesInDir(dir);
	for (const t of targets) {
		const { json, indent, eol } = await readJsonObjectWithStyle(t.filePath);
		const res = sortObjectKeysShallow(json);
		if (!res.changed) {
			continue;
		}
		const out = `${JSON.stringify(res.sorted, null, indent)}${eol}`;
		await fs.writeFile(t.filePath, out, 'utf8');
		changed += 1;
	}
}

// eslint-disable-next-line no-console
console.log(`Done. ${changed} file(s) changed.`);
