#!/usr/bin/env node
'use strict';

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);

function isPlainObject(value) {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLang(lang) {
	return String(lang).trim().toLowerCase();
}

function compareKeys(a, b) {
	const aa = String(a);
	const bb = String(b);
	const al = aa.toLowerCase();
	const bl = bb.toLowerCase();
	if (al < bl) {
		return -1;
	}
	if (al > bl) {
		return 1;
	}
	if (aa < bb) {
		return -1;
	}
	if (aa > bb) {
		return 1;
	}
	return 0;
}

function stableSortStrings(list) {
	return list.slice().sort((a, b) => compareKeys(a, b));
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

function toSortedObject(json) {
	const sorted = Object.create(null);
	for (const key of stableSortStrings(Object.keys(json || {}))) {
		sorted[key] = json[key];
	}
	return sorted;
}

function textForJson(json, indent, eol) {
	return `${JSON.stringify(toSortedObject(json), null, indent)}${eol}`;
}

async function pathExists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function discoverPluginDirs() {
	const libDir = 'lib';
	const entries = await fs.readdir(libDir, { withFileTypes: true });
	const byType = new Map();

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		if (!entry.name || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '_generated') {
			continue;
		}

		const dir = entry.name;
		const manifestPath = path.join(process.cwd(), libDir, dir, 'manifest.js');
		if (!(await pathExists(manifestPath))) {
			continue;
		}

		const mod = require(manifestPath);
		const manifest = mod?.manifest;
		const type = typeof manifest?.type === 'string' ? manifest.type.trim() : '';
		if (!type) {
			throw new Error(`Plugin manifest without valid type: ${manifestPath}`);
		}
		if (byType.has(type)) {
			throw new Error(`Duplicate plugin type '${type}' in ${manifestPath}`);
		}

		byType.set(type, {
			type,
			dir,
			dirPath: path.join(libDir, dir),
			i18nDir: path.join(libDir, dir, 'i18n'),
		});
	}

	return byType;
}

function classifyRuntimeKey(key, pluginDirsByType, filePath) {
	const prefix = 'msghub.i18n.';
	if (!String(key).startsWith(prefix)) {
		throw new Error(`Unexpected runtime i18n key outside msghub.i18n.* in ${filePath}: ${key}`);
	}

	const rest = key.slice(prefix.length);
	const dotIndex = rest.indexOf('.');
	if (dotIndex <= 0) {
		throw new Error(`Cannot determine namespace owner for key in ${filePath}: ${key}`);
	}

	const owner = rest.slice(0, dotIndex);
	if (owner === 'core') {
		return { kind: 'core', owner };
	}
	if (pluginDirsByType.has(owner)) {
		return { kind: 'plugin', owner };
	}

	throw new Error(`Unknown runtime i18n namespace owner '${owner}' in ${filePath}: ${key}`);
}

function ensurePluginFileNamespace(pluginType, json, filePath) {
	const expectedPrefix = `msghub.i18n.${pluginType}.`;
	for (const key of Object.keys(json || {})) {
		if (!String(key).startsWith(expectedPrefix)) {
			throw new Error(`Plugin i18n file contains foreign key outside ${expectedPrefix} in ${filePath}: ${key}`);
		}
	}
}

function ensureConsistentKeySets(pluginType, movedByLang) {
	const langs = stableSortStrings(Object.keys(movedByLang));
	if (!langs.length) {
		return;
	}
	const baseLang = langs.includes('en') ? 'en' : langs[0];
	const baseKeys = stableSortStrings(Object.keys(movedByLang[baseLang] || {}));
	const baseSig = baseKeys.join('\n');
	for (const lang of langs) {
		const keys = stableSortStrings(Object.keys(movedByLang[lang] || {}));
		if (keys.join('\n') !== baseSig) {
			throw new Error(
				`Plugin runtime i18n key drift detected for ${pluginType}: ${baseLang} (${baseKeys.length}) vs ${lang} (${keys.length})`,
			);
		}
	}
}

const { values } = parseArgs({
	options: {
		check: { type: 'boolean' },
		help: { type: 'boolean' },
	},
});

if (values.help) {
	console.log(`Usage:
  node i18n-plugin-runtime-placement.mjs [--check]

Behavior:
  - Moves plugin-owned runtime keys from repo-root i18n/<lang>.json
    into lib/<PluginType>/i18n/<lang>.json.
  - Plugin-owned means: msghub.i18n.<PluginType>.* for discovered plugins.
  - msghub.i18n.core.* remains in repo-root i18n/.
  - Existing plugin i18n files are merged; conflicting values abort.
  - In --check mode: prints what would change and exits with code 2 when
    repo-root i18n still contains plugin-owned keys.
`);
	process.exit(0);
}

const check = Boolean(values.check);
const rootDir = 'i18n';
const pluginDirsByType = await discoverPluginDirs();
const rootTargets = await listLangFilesInDir(rootDir);
if (!rootTargets.length) {
	throw new Error(`No runtime language files found in ${rootDir}`);
}

const rootWrites = [];
const rootMetaByLang = new Map();
const movedByPlugin = new Map();
let changedFiles = 0;

for (const target of rootTargets) {
	const read = await readJsonObjectWithStyle(target.filePath);
	rootMetaByLang.set(target.lang, read);
	const nextRoot = Object.create(null);
	const movedCounts = new Map();

	for (const key of read.keys) {
		const classification = classifyRuntimeKey(key, pluginDirsByType, target.filePath);
		if (classification.kind === 'core') {
			nextRoot[key] = read.json[key];
			continue;
		}

		let byLang = movedByPlugin.get(classification.owner);
		if (!byLang) {
			byLang = Object.create(null);
			movedByPlugin.set(classification.owner, byLang);
		}
		if (!byLang[target.lang]) {
			byLang[target.lang] = Object.create(null);
		}
		byLang[target.lang][key] = read.json[key];
		movedCounts.set(classification.owner, (movedCounts.get(classification.owner) || 0) + 1);
	}

	const nextText = textForJson(nextRoot, read.indent, read.eol);
	if (nextText !== read.text) {
		rootWrites.push({ ...target, ...read, nextJson: nextRoot, nextText });
		changedFiles += 1;
	}

	if (check) {
		for (const [pluginType, count] of Array.from(movedCounts.entries()).sort((a, b) => compareKeys(a[0], b[0]))) {
			console.log(
				`[check] ${target.filePath}: would move ${count} key(s) to lib/${pluginDirsByType.get(pluginType).dir}/i18n`,
			);
		}
	}
}

const pluginWrites = [];

for (const [pluginType, pluginInfo] of Array.from(pluginDirsByType.entries()).sort((a, b) => compareKeys(a[0], b[0]))) {
	const movedByLang = movedByPlugin.get(pluginType) || Object.create(null);
	ensureConsistentKeySets(pluginType, movedByLang);
	for (const target of rootTargets) {
		const movedJson = movedByLang[target.lang] || Object.create(null);
		const outPath = path.join(pluginInfo.i18nDir, `${target.lang}.json`);
		const rootMeta = rootMetaByLang.get(target.lang);
		if (!rootMeta) {
			throw new Error(`Missing runtime root metadata for language ${target.lang}`);
		}

		let existingText = null;
		let existingJson = Object.create(null);
		let indent = rootMeta.indent;
		let eol = rootMeta.eol;

		if (await pathExists(outPath)) {
			const read = await readJsonObjectWithStyle(outPath);
			existingText = read.text;
			existingJson = read.json;
			indent = read.indent;
			eol = read.eol;
			ensurePluginFileNamespace(pluginType, existingJson, outPath);
		} else if (Object.keys(movedJson).length === 0) {
			continue;
		}

		const merged = Object.create(null);
		for (const key of Object.keys(existingJson)) {
			merged[key] = existingJson[key];
		}
		for (const key of Object.keys(movedJson)) {
			if (Object.prototype.hasOwnProperty.call(existingJson, key) && existingJson[key] !== movedJson[key]) {
				throw new Error(`Conflicting translation for ${key} in ${outPath}`);
			}
			merged[key] = movedJson[key];
		}

		const nextText = textForJson(merged, indent, eol);
		if (nextText === existingText) {
			continue;
		}

		pluginWrites.push({
			pluginType,
			outPath,
			nextText,
		});
		changedFiles += 1;

		if (check) {
			console.log(`[check] ${outPath}: would write plugin runtime i18n`);
		}
	}
}

if (check && changedFiles > 0) {
	console.log(`Done. ${changedFiles} file(s) need runtime i18n placement updates.`);
	process.exit(2);
}

for (const write of pluginWrites) {
	await fs.mkdir(path.dirname(write.outPath), { recursive: true });
	await fs.writeFile(write.outPath, write.nextText, 'utf8');
	console.log(`[write] ${write.outPath}`);
}

for (const write of rootWrites) {
	await fs.writeFile(write.filePath, write.nextText, 'utf8');
	console.log(`[write] ${write.filePath}`);
}

console.log(`Done. ${changedFiles} file(s) written.`);
