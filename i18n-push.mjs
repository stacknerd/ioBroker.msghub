#!/usr/bin/env node
'use strict';

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

function isPlainObject(value) {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function detectIndent(jsonText) {
	// Keep existing style: admin/i18n uses tabs, i18n uses 2 spaces
	if (/\n\t\"/.test(jsonText)) return '\t';
	return 2;
}

function detectEol(text) {
	return text.includes('\r\n') ? '\r\n' : '\n';
}

async function readJsonFile(filePath) {
	const text = await fs.readFile(filePath, 'utf8');
	return { text, json: JSON.parse(text) };
}

async function writeJsonFile(filePath, json, indent, eol) {
	const out = `${JSON.stringify(json, null, indent)}${eol}`;
	await fs.writeFile(filePath, out, 'utf8');
}

function printHelp() {
	// eslint-disable-next-line no-console
	console.log(`Usage:
  node i18n-push.mjs [options] [json]

Distributes a {lang: text} JSON object into the repo's i18n JSON files.
By default it updates only \`i18n/*.json\`.
If input is read from a file, the file is cleared after a successful import (use --keep-file to disable).

Examples:
  npm run i18n:push -- --key "Some key" --json '{"en":"Hello","de":"Hallo"}'
  npm run i18n:push -- --json '{"en":"MsgHub plugin (%s/%s/%s)","de":"MsgHub-Plugin (%s/%s/%s)"}'
  cat entry.json | npm run i18n:push -- --stdin

	Options:
	  --key <string>              Translation key (default: value of "en")
	  --json <string>             JSON string with {lang: text}
	  --file <path>               Read JSON input from file
	  --stdin                     Read JSON input from stdin
  --keep-file                 Keep input file content (do not auto-clear)
  (Input file may also contain multiple JSON objects concatenated; all will be imported.)
  --scope <all|runtime|admin>  Target i18n dirs (default: runtime)
  --dir <path>                Add custom i18n dir (repeatable; overrides --scope)
  --dry-run                   Do not write, only print planned changes
  --strict                    Require a value for every language file (no fallback)
  --help                      Show this help
`);
}

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString('utf8');
}

async function isFile(filePath) {
	try {
		return (await fs.stat(filePath)).isFile();
	} catch (e) {
		if (/** @type {any} */ (e)?.code === 'ENOENT') return false;
		throw e;
	}
}

function normalizeLang(lang) {
	return String(lang).trim().toLowerCase();
}

function ensureStringMap(input) {
	if (!isPlainObject(input)) {
		throw new Error('Input must be a JSON object like {"en":"...","de":"..."}');
	}
	for (const [k, v] of Object.entries(input)) {
		if (typeof v !== 'string') {
			throw new Error(`Invalid value for "${k}": expected string, got ${typeof v}`);
		}
	}
	return /** @type {Record<string, string>} */ (input);
}

function tryParseJson(text) {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (e) {
		return { ok: false, error: e };
	}
}

function parseConcatenatedJsonValues(text) {
	/** @type {any[]} */
	const values = [];
	const len = text.length;
	let i = 0;

	const isSkippable = ch => ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',' || ch === ';';

	while (i < len) {
		while (i < len && isSkippable(text[i])) i += 1;
		if (i >= len) break;

		const start = i;
		const first = text[i];
		if (first !== '{' && first !== '[') {
			throw new Error(`Invalid input: expected JSON value at position ${i}`);
		}

		let depth = 0;
		let inString = false;
		let escape = false;

		for (; i < len; i += 1) {
			const ch = text[i];
			if (inString) {
				if (escape) {
					escape = false;
				} else if (ch === '\\') {
					escape = true;
				} else if (ch === '"') {
					inString = false;
				}
				continue;
			}

			if (ch === '"') {
				inString = true;
				continue;
			}
			if (ch === '{' || ch === '[') {
				depth += 1;
				continue;
			}
			if (ch === '}' || ch === ']') {
				depth -= 1;
				if (depth === 0) {
					i += 1;
					const raw = text.slice(start, i);
					values.push(JSON.parse(raw));
					break;
				}
			}
		}

		if (depth !== 0) {
			throw new Error('Invalid input: unterminated JSON value');
		}
	}

	return values;
}

function parseInputEntries(inputText) {
	const parsed = tryParseJson(inputText.trim());
	if (parsed.ok) {
		if (Array.isArray(parsed.value)) return parsed.value;
		return [parsed.value];
	}

	// Fallback: allow concatenated JSON objects (useful for "queue" files).
	return parseConcatenatedJsonValues(inputText);
}

async function listLangFilesInDir(dirPath) {
	let entries;
	try {
		entries = await fs.readdir(dirPath, { withFileTypes: true });
	} catch (e) {
		if (/** @type {any} */ (e)?.code === 'ENOENT') return [];
		throw e;
	}

	return entries
		.filter(e => e.isFile() && e.name.endsWith('.json'))
		.map(e => ({
			lang: normalizeLang(e.name.slice(0, -'.json'.length)),
			filePath: path.join(dirPath, e.name),
		}));
}

async function upsertEntry({ filePath, key, value, dryRun }) {
	let existingText = '';
	let existingJson = {};
	let indent = 2;
	let eol = '\n';

	try {
		const read = await readJsonFile(filePath);
		existingText = read.text;
		existingJson = read.json;
		indent = detectIndent(existingText);
		eol = detectEol(existingText);
	} catch (e) {
		if (/** @type {any} */ (e)?.code !== 'ENOENT') throw e;
	}

	if (!isPlainObject(existingJson)) {
		throw new Error(`File is not a JSON object: ${filePath}`);
	}

	const prev = existingJson[key];
	if (prev === value) return { changed: false, created: existingText === '' };

	existingJson[key] = value;
	if (!dryRun) await writeJsonFile(filePath, existingJson, indent, eol);
	return { changed: true, created: existingText === '' };
}

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		key: { type: 'string' },
		json: { type: 'string' },
		file: { type: 'string' },
		stdin: { type: 'boolean' },
		'keep-file': { type: 'boolean' },
		scope: { type: 'string' },
		dir: { type: 'string', multiple: true },
		'dry-run': { type: 'boolean' },
		strict: { type: 'boolean' },
		help: { type: 'boolean' },
	},
});

if (values.help) {
	printHelp();
	process.exit(0);
}

const dryRun = Boolean(values['dry-run']);
const strict = Boolean(values.strict);
const keepFile = Boolean(values['keep-file']);

/** @type {string[]} */
let targetDirs = [];
if (values.dir?.length) {
	targetDirs = values.dir;
	} else {
		const scope = String(values.scope ?? 'runtime').toLowerCase();
		if (!['all', 'runtime', 'admin'].includes(scope)) {
			throw new Error(`Invalid --scope "${values.scope}". Use all|runtime|admin.`);
		}
	if (scope === 'all' || scope === 'runtime') targetDirs.push('i18n');
	if (scope === 'all' || scope === 'admin') targetDirs.push(path.join('admin', 'i18n'));
}

let inputText = values.json ?? '';
let inputFilePath = values.file ? String(values.file) : '';
let inputFileEol = '\n';
if (!inputText && values.file) {
	inputText = await fs.readFile(inputFilePath, 'utf8');
	inputFileEol = detectEol(inputText);
}
if (!inputText && values.stdin) {
	inputText = await readStdin();
}
if (!inputText && positionals.length) {
	const first = String(positionals[0]);
	// Convenience: allow passing a file path as positional (e.g. via `npm run ... --file foo.json` without `--`).
	if (await isFile(first)) {
		inputFilePath = first;
		inputText = await fs.readFile(first, 'utf8');
		inputFileEol = detectEol(inputText);
	} else {
		inputText = first;
	}
}
if (!inputText && !process.stdin.isTTY) {
	inputText = await readStdin();
}

if (!inputText) {
	printHelp();
	throw new Error('No input provided. Use --json, --file, --stdin or pass JSON as positional arg.');
}

const allTargets = [];
for (const dirPath of targetDirs) {
	const langFiles = await listLangFilesInDir(dirPath);
	for (const lf of langFiles) allTargets.push(lf);
}

if (!allTargets.length) {
	throw new Error(`No i18n JSON files found in: ${targetDirs.join(', ')}`);
}

const entries = parseInputEntries(inputText);
if (entries.length > 1 && values.key) {
	throw new Error('When importing multiple entries, do not use --key. Use "en" as key per entry.');
}

let changedCount = 0;
for (const entry of entries) {
	const langMapRaw = ensureStringMap(entry);
	const langMap = Object.fromEntries(Object.entries(langMapRaw).map(([k, v]) => [normalizeLang(k), v]));

	const key = values.key ?? langMap.en;
	if (!key || typeof key !== 'string') {
		throw new Error('Missing --key and no "en" value to infer the key from.');
	}

	const fallback = langMap.en;
	/** @type {{filePath: string, lang: string, value: string}[]} */
	const ops = [];
	for (const t of allTargets) {
		const v = langMap[t.lang];
		if (typeof v === 'string') {
			ops.push({ ...t, value: v });
		} else if (!strict && typeof fallback === 'string') {
			ops.push({ ...t, value: fallback });
		} else {
			throw new Error(`Missing translation for "${t.lang}" (file: ${t.filePath}). Provide it or omit --strict.`);
		}
	}

	// eslint-disable-next-line no-console
	console.log(`${dryRun ? '[dry-run] ' : ''}Updating key: ${JSON.stringify(key)}`);

	for (const op of ops) {
		const res = await upsertEntry({ filePath: op.filePath, key, value: op.value, dryRun });
		if (res.changed) changedCount += 1;
		// eslint-disable-next-line no-console
		console.log(`${res.changed ? 'update' : 'skip  '} ${op.filePath} (${op.lang})`);
	}
}

// eslint-disable-next-line no-console
console.log(`${dryRun ? '[dry-run] ' : ''}Done. ${changedCount} file(s) ${dryRun ? 'would change' : 'changed'}.`);

if (!dryRun && inputFilePath && !keepFile) {
	await fs.writeFile(inputFilePath, `{}` + inputFileEol, 'utf8');
	// eslint-disable-next-line no-console
	console.log(`cleared ${inputFilePath}`);
}
