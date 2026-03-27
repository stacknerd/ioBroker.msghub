#!/usr/bin/env node
'use strict';

// Generates lib/_generated/backend-i18n/root-admin/<lang>.json from admin/i18n/*.json.
// All keys from admin/i18n/ are copied verbatim (no regex filter — ADR-C1).
// Source indentation and EOL are detected and preserved per source file.
// --check: prints what would change and exits with code 2 when changes are needed.

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
	return { text, json, indent: detectIndent(text), eol: detectEol(text) };
}

async function listLangFilesInDir(dirPath) {
	let entries;
	try {
		entries = await fs.readdir(dirPath, { withFileTypes: true });
	} catch (e) {
		if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') {
			throw new Error(`Admin i18n directory not found: ${dirPath}`);
		}
		throw e;
	}
	const files = entries.filter(e => e.isFile() && e.name.endsWith('.json'));
	if (!files.length) {
		throw new Error(`No JSON files found in ${dirPath}`);
	}
	return files.map(e => ({
		lang: normalizeLang(path.basename(e.name, '.json')),
		filePath: path.join(dirPath, e.name),
	}));
}

const { values } = parseArgs({
	options: {
		check: { type: 'boolean' },
		help: { type: 'boolean' },
	},
});

if (values.help) {
	// eslint-disable-next-line no-console
	console.log(`Usage:
  node i18n-generate-backend-overlay.mjs [--check]

Behavior:
  - Copies ALL keys from admin/i18n/<lang>.json into
    lib/_generated/backend-i18n/root-admin/<lang>.json (no key filter — ADR-C1).
  - Detects and preserves source file indentation and EOL style.
  - In --check mode: prints what would change and exits non-zero when changes are needed.
`);
	process.exit(0);
}

const check = Boolean(values.check);
const adminDir = path.join('admin', 'i18n');
const outDir = path.join('lib', '_generated', 'backend-i18n', 'root-admin');

const adminTargets = await listLangFilesInDir(adminDir);

if (!check) {
	await fs.mkdir(outDir, { recursive: true });
}

let changedFiles = 0;

for (const { lang, filePath: adminPath } of adminTargets) {
	const outPath = path.join(outDir, `${lang}.json`);
	const { json, indent, eol } = await readJsonObjectWithStyle(adminPath);
	const nextText = `${JSON.stringify(json, null, indent)}${eol}`;

	let existingText = null;
	try {
		existingText = await fs.readFile(outPath, 'utf8');
	} catch (e) {
		if (!e || typeof e !== 'object' || !('code' in e) || e.code !== 'ENOENT') {
			throw e;
		}
	}

	if (nextText === existingText) {
		continue;
	}

	changedFiles += 1;

	if (check) {
		// eslint-disable-next-line no-console
		console.log(`[check] ${lang}: would write ${outPath}`);
		continue;
	}

	await fs.writeFile(outPath, nextText, 'utf8');
	// eslint-disable-next-line no-console
	console.log(`[write] ${lang}: ${outPath}`);
}

if (check && changedFiles > 0) {
	// eslint-disable-next-line no-console
	console.log(`Done. ${changedFiles} file(s) need to be generated.`);
	process.exit(2);
}

// eslint-disable-next-line no-console
console.log(`Done. ${changedFiles} file(s) written.`);
