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
	return list.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
	return new Set(Object.keys(json || {}).filter(k => typeof k === 'string' && k.trim()));
}

function diffKeys(base, other) {
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

function decodeJsStringLiteral(raw) {
	// Best-effort decoding for simple JS string literals.
	// Supports: \\n \\r \\t \\\\ \\' \\\" \\xNN \\uNNNN
	let out = '';
	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];
		if (ch !== '\\') {
			out += ch;
			continue;
		}
		const next = raw[i + 1];
		if (next === undefined) {
			out += '\\';
			continue;
		}
		if (next === 'n') {
			out += '\n';
			i += 1;
			continue;
		}
		if (next === 'r') {
			out += '\r';
			i += 1;
			continue;
		}
		if (next === 't') {
			out += '\t';
			i += 1;
			continue;
		}
		if (next === '\\' || next === '"' || next === "'") {
			out += next;
			i += 1;
			continue;
		}
		if (next === 'x') {
			const hex = raw.slice(i + 2, i + 4);
			if (/^[0-9a-fA-F]{2}$/.test(hex)) {
				out += String.fromCharCode(parseInt(hex, 16));
				i += 3;
				continue;
			}
		}
		if (next === 'u') {
			const hex = raw.slice(i + 2, i + 6);
			if (/^[0-9a-fA-F]{4}$/.test(hex)) {
				out += String.fromCharCode(parseInt(hex, 16));
				i += 5;
				continue;
			}
		}
		out += next;
		i += 1;
	}
	return out;
}

function extractLiteralArgs(text, calleePatterns) {
	const out = [];
	for (const p of calleePatterns) {
		const re = new RegExp(String.raw`\b${p}\s*\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1`, 'g');
		let m;
		while ((m = re.exec(text)) != null) {
			out.push({ raw: m[2], index: m.index, callee: p });
		}
	}
	return out;
}

function detectWrapperFunctions(text) {
	const wrappers = new Set();
	const re =
		/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>\s*[^;]*\b(?:i18n|ctx\.api\.i18n|this\.i18n|adapter\.i18n)\.t\s*\(/g;
	let m;
	while ((m = re.exec(text)) != null) {
		wrappers.add(m[1]);
	}
	return wrappers;
}

async function walkFiles(root, { include, excludeDirs }) {
	const out = [];
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop();
		if (!dir) {
			break;
		}
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (excludeDirs.has(entry.name)) {
					continue;
				}
				stack.push(full);
				continue;
			}
			if (!entry.isFile()) {
				continue;
			}
			if (include.test(entry.name)) {
				out.push(full);
			}
		}
	}
	return out;
}

async function collectRuntimeUsage({ roots }) {
	const excludeDirs = new Set(['node_modules', '.git', 'admin', 'test', 'docs']);
	const files = [];
	for (const root of roots) {
		const discovered = await walkFiles(root, {
			include: /\.(c?js|mjs)$/i,
			excludeDirs,
		});
		for (const filePath of discovered) {
			if (/\.(test|spec)\.(c?js|mjs)$/i.test(filePath)) {
				continue;
			}
			files.push(filePath);
		}
	}
	if (!files.includes(path.resolve('main.js'))) {
		files.push(path.resolve('main.js'));
	}

	const keyToFiles = new Map();
	const add = (key, filePath) => {
		if (!key || typeof key !== 'string') {
			return;
		}
		const k = key.trim();
		if (!k) {
			return;
		}
		const set = keyToFiles.get(k) || new Set();
		set.add(filePath);
		keyToFiles.set(k, set);
	};

	for (const filePath of stableSortStrings(files)) {
		let text;
		try {
			text = await fs.readFile(filePath, 'utf8');
		} catch {
			continue;
		}

		const wrappers = detectWrapperFunctions(text);
		const directCallees = ['i18n\\.t', 'ctx\\.api\\.i18n\\.t', 'this\\.i18n\\.t', 'adapter\\.i18n\\.t'];
		const getTranslated = [
			'i18n\\.getTranslatedObject',
			'ctx\\.api\\.i18n\\.getTranslatedObject',
			'this\\.i18n\\.getTranslatedObject',
			'adapter\\.i18n\\.getTranslatedObject',
		];

		const calls = [...extractLiteralArgs(text, directCallees), ...extractLiteralArgs(text, getTranslated)];
		for (const call of calls) {
			add(decodeJsStringLiteral(call.raw), filePath);
		}

		for (const name of wrappers) {
			const wrapperCalls = extractLiteralArgs(text, [name.replace(/\$/g, '\\$')]);
			for (const call of wrapperCalls) {
				add(decodeJsStringLiteral(call.raw), filePath);
			}
		}
	}

	return keyToFiles;
}

async function collectAdminUsageKeys() {
	const out = new Set();
	const allowedFields = new Set([
		'label',
		'help',
		'text',
		'title',
		'placeholder',
		'caption',
		'hint',
		'tooltip',
		'description',
	]);

	const collectFromConfig = json => {
		const walk = node => {
			if (Array.isArray(node)) {
				for (const item of node) {
					walk(item);
				}
				return;
			}
			if (!isPlainObject(node)) {
				return;
			}
			for (const [key, value] of Object.entries(node)) {
				if (allowedFields.has(key) && typeof value === 'string') {
					const s = value.trim();
					if (s) {
						out.add(s);
					}
					continue;
				}
				walk(value);
			}
		};
		walk(json);
	};

	const candidates = ['admin/jsonConfig.json', 'admin/jsonCustom.json'];
	for (const filePath of candidates) {
		let json;
		try {
			json = await readJsonObject(filePath);
		} catch {
			continue;
		}
		collectFromConfig(json);
	}
	return out;
}

function previewKey(key, { maxLen }) {
	const raw = typeof key === 'string' ? key : String(key);
	const single = raw.replace(/\s+/g, ' ').trim();
	if (single.length <= maxLen) {
		return JSON.stringify(single);
	}
	const head = single.slice(0, Math.max(0, maxLen - 1));
	return `${JSON.stringify(`${head}…`)} (len=${single.length})`;
}

function formatTextReport(report, { maxList, maxKeyLen }) {
	const lines = [];
	const push = s => lines.push(String(s));

	push(`i18n audit (scope=${report.scope})`);

	for (const area of report.areas) {
		push('');
		push(`[${area.name}] dir=${area.dir} base=${area.baseLang} keys=${area.baseCount}`);
		for (const lang of area.languages) {
			const d = area.diffByLang[lang];
			push(`- ${lang}: keys=${area.countByLang[lang]} missing=${d.missing.length} extra=${d.extra.length}`);
			if (d.missing.length) {
				push('  missing:');
				for (const key of d.missing.slice(0, maxList)) {
					push(`  - ${previewKey(key, { maxLen: maxKeyLen })}`);
				}
				if (d.missing.length > maxList) {
					push(`  - … (${d.missing.length - maxList} more)`);
				}
			}
			if (d.extra.length) {
				push('  extra:');
				for (const key of d.extra.slice(0, maxList)) {
					push(`  - ${previewKey(key, { maxLen: maxKeyLen })}`);
				}
				if (d.extra.length > maxList) {
					push(`  - … (${d.extra.length - maxList} more)`);
				}
			}
		}

		if (area.usage) {
			push('');
			push(`[${area.name}] usage (best-effort)`);
			push(`- used keys: ${area.usage.usedCount}`);
			push(`- missing in base (${area.baseLang}): ${area.usage.missingInBase.length}`);
			if (area.usage.missingInBase.length) {
				push('  missingInBase:');
				for (const key of area.usage.missingInBase.slice(0, maxList)) {
					push(`  - ${previewKey(key, { maxLen: maxKeyLen })}`);
				}
				if (area.usage.missingInBase.length > maxList) {
					push(`  - … (${area.usage.missingInBase.length - maxList} more)`);
				}
				if (area.usage.keyToFiles && typeof area.usage.keyToFiles === 'object') {
					push('  missingInBase details:');
					for (const key of area.usage.missingInBase.slice(0, maxList)) {
						const files = Array.isArray(area.usage.keyToFiles[key]) ? area.usage.keyToFiles[key] : [];
						push(
							`  - ${JSON.stringify(key)} -> ${files
								.slice(0, 3)
								.map(f => `\`${f}\``)
								.join(', ')}${files.length > 3 ? ' …' : ''}`,
						);
					}
				}
			}
			push(`- unused in base (${area.baseLang}): ${area.usage.unusedInBase.length}`);
			if (area.usage.unusedInBase.length) {
				push('  unusedInBase:');
				for (const key of area.usage.unusedInBase.slice(0, maxList)) {
					push(`  - ${previewKey(key, { maxLen: maxKeyLen })}`);
				}
				if (area.usage.unusedInBase.length > maxList) {
					push(`  - … (${area.usage.unusedInBase.length - maxList} more)`);
				}
			}
		}
	}

	return lines.join('\n');
}

function hasSyncProblems(area) {
	return area.languages.some(lang => {
		const d = area.diffByLang[lang];
		return d.missing.length > 0 || d.extra.length > 0;
	});
}

function hasUsageProblems(area) {
	return Boolean(area.usage && area.usage.missingInBase.length > 0);
}

function resolveTargetDirs(scope) {
	const s = String(scope || 'runtime').toLowerCase();
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

async function buildAreaReport({ name, dir, enableUsage }) {
	const targets = await listLangFilesInDir(dir);
	if (!targets.length) {
		return {
			name,
			dir,
			baseLang: null,
			baseCount: 0,
			languages: [],
			countByLang: {},
			diffByLang: {},
			usage: enableUsage ? { usedCount: 0, missingInBase: [], unusedInBase: [] } : null,
		};
	}

	const langs = stableSortStrings(targets.map(t => t.lang));
	const baseLang = langs.includes('en') ? 'en' : langs[0];

	const keysByLang = {};
	const countByLang = {};
	for (const t of targets) {
		const json = await readJsonObject(t.filePath);
		const keys = collectKeys(json);
		keysByLang[t.lang] = keys;
		countByLang[t.lang] = keys.size;
	}

	const base = keysByLang[baseLang] || new Set();
	const diffByLang = {};
	for (const lang of langs) {
		diffByLang[lang] = diffKeys(base, keysByLang[lang] || new Set());
	}

	let usage = null;
	if (enableUsage) {
		if (dir === 'i18n') {
			const keyToFiles = await collectRuntimeUsage({ roots: ['src', 'lib'] });
			const used = new Set(keyToFiles.keys());
			const missingInBase = stableSortStrings([...used].filter(k => !base.has(k)));
			const unusedInBase = stableSortStrings([...base].filter(k => !used.has(k)));
			usage = {
				usedCount: used.size,
				missingInBase,
				unusedInBase,
				keyToFiles: Object.fromEntries(
					stableSortStrings([...keyToFiles.keys()]).map(k => [k, stableSortStrings([...keyToFiles.get(k)])]),
				),
			};
		} else {
			const used = await collectAdminUsageKeys();
			const missingInBase = stableSortStrings([...used].filter(k => !base.has(k)));
			usage = {
				usedCount: used.size,
				missingInBase,
				unusedInBase: [],
			};
		}
	}

	return {
		name,
		dir,
		baseLang,
		baseCount: base.size,
		languages: langs,
		countByLang,
		diffByLang,
		usage,
	};
}

const { values } = parseArgs({
	options: {
		scope: { type: 'string' },
		format: { type: 'string' },
		check: { type: 'boolean' },
		usage: { type: 'boolean' },
		'max-list': { type: 'string' },
		'max-key-len': { type: 'string' },
		help: { type: 'boolean' },
	},
});

if (values.help) {
	console.log(`Usage:
  node i18n-audit.mjs [--scope all|runtime|admin] [--format text|json] [--check] [--usage] [--max-list N] [--max-key-len N]

Purpose:
  - Check whether i18n language files are in sync (same keys across languages).
  - Best-effort scan for used keys and report missing/unused keys (runtime and admin).

Notes:
  - Usage scanning is intentionally best-effort (dynamic keys can't be detected reliably).
  - --check fails only on "sync" errors and on used keys missing from the base language.
`);
	process.exit(0);
}

const scope = values.scope ?? 'runtime';
const format = String(values.format ?? 'text').toLowerCase();
const check = Boolean(values.check);
const enableUsage = values.usage !== false;
const maxListRaw = values['max-list'];
const maxList = Number.isFinite(Number(maxListRaw)) ? Math.max(0, Math.trunc(Number(maxListRaw))) : 25;
const maxKeyLenRaw = values['max-key-len'];
const maxKeyLen = Number.isFinite(Number(maxKeyLenRaw)) ? Math.max(20, Math.trunc(Number(maxKeyLenRaw))) : 140;

const dirs = resolveTargetDirs(scope);
const areas = [];
for (const dir of dirs) {
	const name = dir === 'i18n' ? 'runtime' : 'admin';
	areas.push(await buildAreaReport({ name, dir, enableUsage }));
}

const report = {
	scope: String(scope),
	areas,
};

if (format === 'json') {
	console.log(JSON.stringify(report, null, 2));
} else if (format === 'text') {
	console.log(formatTextReport(report, { maxList, maxKeyLen }));
} else {
	throw new Error(`Invalid --format "${values.format}". Use text|json.`);
}

if (check) {
	const syncProblems = areas.some(hasSyncProblems);
	const usageProblems = areas.some(hasUsageProblems);
	if (syncProblems || usageProblems) {
		process.exitCode = 1;
	}
}
