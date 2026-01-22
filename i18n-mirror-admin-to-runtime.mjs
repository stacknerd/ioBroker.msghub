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

function filterKeysByRegex(json, re) {
	const out = Object.create(null);
	for (const [key, value] of Object.entries(json)) {
		if (!re.test(key)) {
			continue;
		}
		out[key] = value;
	}
	return out;
}

function mergeObjects(a, b) {
	const out = Object.create(null);
	for (const [k, v] of Object.entries(a || {})) {
		out[k] = v;
	}
	for (const [k, v] of Object.entries(b || {})) {
		out[k] = v;
	}
	return out;
}

function buildNextRuntimeJson({ runtimeRead, keyRe, desiredSubset }) {
	const out = Object.create(null);

	// Keep non-mirrored keys in their original order for minimal diffs.
	for (const key of runtimeRead.keys) {
		if (keyRe.test(key)) {
			continue;
		}
		out[key] = runtimeRead.json[key];
	}

	// Append mirrored keys in deterministic order.
	for (const key of Object.keys(desiredSubset).sort()) {
		out[key] = desiredSubset[key];
	}

	return out;
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
  node i18n-mirror-admin-to-runtime.mjs [--check]

Behavior:
  - Mirrors keys matching "msghub.i18n.*.admin.*" (exactly one segment between i18n and admin)
    from admin/i18n/*.json into i18n/*.json.
  - Overwrites mirrored keys in runtime i18n (admin wins).
  - Removes mirrored keys from runtime i18n when they no longer exist in admin/i18n.
  - In --check mode: prints what would change and exits non-zero when changes are needed.
`);
	process.exit(0);
}

const check = Boolean(values.check);
const adminDir = path.join('admin', 'i18n');
const runtimeDir = 'i18n';
const keyRe = /^msghub\.i18n\.[^.]+\.admin\./;

const adminTargets = await listLangFilesInDir(adminDir);
const runtimeTargets = await listLangFilesInDir(runtimeDir);

if (!adminTargets.length) {
	throw new Error(`Missing admin i18n files in ${adminDir}`);
}
if (!runtimeTargets.length) {
	throw new Error(`Missing runtime i18n files in ${runtimeDir}`);
}

const adminByLang = new Map(adminTargets.map(t => [t.lang, t.filePath]));
const runtimeByLang = new Map(runtimeTargets.map(t => [t.lang, t.filePath]));

const adminEnPath = adminByLang.get('en');
if (!adminEnPath) {
	throw new Error(`[admin] missing base language file (en.json) in ${adminDir}`);
}

const adminEn = await readJsonObjectWithStyle(adminEnPath);
const adminEnSubset = filterKeysByRegex(adminEn.json, keyRe);

const allLangs = Array.from(new Set([...adminByLang.keys(), ...runtimeByLang.keys()])).sort();
let changedFiles = 0;

for (const lang of allLangs) {
	const runtimePath = runtimeByLang.get(lang) || null;
	if (!runtimePath) {
		// eslint-disable-next-line no-console
		console.log(`[skip] ${lang}: missing runtime file in ${runtimeDir}`);
		continue;
	}

	const adminPath = adminByLang.get(lang) || null;
	const adminLangSubset = adminPath ? filterKeysByRegex((await readJsonObjectWithStyle(adminPath)).json, keyRe) : null;

	const desiredSubset = mergeObjects(adminEnSubset, adminLangSubset || {});
	const runtimeRead = await readJsonObjectWithStyle(runtimePath);
	const nextJson = buildNextRuntimeJson({ runtimeRead, keyRe, desiredSubset });
	const nextText = `${JSON.stringify(nextJson, null, runtimeRead.indent)}${runtimeRead.eol}`;

	if (nextText === runtimeRead.text) {
		continue;
	}

	changedFiles += 1;

	if (check) {
		// eslint-disable-next-line no-console
		console.log(`[check] ${lang}: would update ${runtimePath}`);
		continue;
	}

	await fs.writeFile(runtimePath, nextText, 'utf8');
	// eslint-disable-next-line no-console
	console.log(`[write] ${lang}: updated ${runtimePath}`);
}

if (check && changedFiles > 0) {
	// eslint-disable-next-line no-console
	console.log(`Done. ${changedFiles} file(s) need updates.`);
	process.exit(2);
}

// eslint-disable-next-line no-console
console.log(`Done. ${changedFiles} file(s) changed.`);

