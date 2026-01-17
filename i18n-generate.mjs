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

function buildSyncedLangObject({ baseKeys, baseJson, langJson, remove }) {
	const out = Object.create(null);

	for (const key of baseKeys) {
		if (Object.prototype.hasOwnProperty.call(langJson, key)) {
			out[key] = langJson[key];
		} else {
			out[key] = baseJson[key];
		}
	}

	if (!remove) {
		for (const key of Object.keys(langJson)) {
			if (!Object.prototype.hasOwnProperty.call(baseJson, key)) {
				out[key] = langJson[key];
			}
		}
	}

	return out;
}

function diffGenerate({ baseKeys, baseJson, langJson, remove }) {
	let missing = 0;
	let extra = 0;

	for (const key of baseKeys) {
		if (!Object.prototype.hasOwnProperty.call(langJson, key)) {
			missing += 1;
		}
	}

	if (remove) {
		for (const key of Object.keys(langJson)) {
			if (!Object.prototype.hasOwnProperty.call(baseJson, key)) {
				extra += 1;
			}
		}
	}

	return { missing, extra };
}

const { values } = parseArgs({
	options: {
		scope: { type: 'string' },
		remove: { type: 'boolean' },
		help: { type: 'boolean' },
	},
});

if (values.help) {
	// eslint-disable-next-line no-console
	console.log(`Usage:
  node i18n-generate.mjs [--scope all|runtime|admin] [--remove]

Behavior:
  - Adds missing keys (compared to en.json) to every other language file, using the en text as value.
  - With --remove: removes keys from other language files that do not exist in en.json.
`);
	process.exit(0);
}

const scope = values.scope ?? 'all';
const remove = Boolean(values.remove);

const dirs = resolveTargetDirs(scope);
let changedFiles = 0;

for (const dir of dirs) {
	const name = dir === 'i18n' ? 'runtime' : 'admin';
	const targets = await listLangFilesInDir(dir);
	if (!targets.length) {
		// eslint-disable-next-line no-console
		console.log(`[${name}] dir=${dir}: no language files`);
		continue;
	}

	const enTarget = targets.find(t => t.lang === 'en') || null;
	if (!enTarget) {
		throw new Error(`[${name}] dir=${dir}: missing base language file (en.json)`);
	}

	const base = await readJsonObjectWithStyle(enTarget.filePath);
	const baseKeys = base.keys;
	const baseJson = base.json;

	for (const t of targets) {
		if (t.lang === 'en') {
			continue;
		}

		const read = await readJsonObjectWithStyle(t.filePath);
		const { missing, extra } = diffGenerate({ baseKeys, baseJson, langJson: read.json, remove });
		if (missing === 0 && extra === 0) {
			continue;
		}

		const nextJson = buildSyncedLangObject({ baseKeys, baseJson, langJson: read.json, remove });
		const out = `${JSON.stringify(nextJson, null, read.indent)}${read.eol}`;
		await fs.writeFile(t.filePath, out, 'utf8');
		changedFiles += 1;

		// eslint-disable-next-line no-console
		console.log(`[${name}] ${t.lang}: +${missing}${remove ? ` -${extra}` : ''} (${t.filePath})`);
	}
}

// eslint-disable-next-line no-console
console.log(`Done. ${changedFiles} file(s) changed.`);

