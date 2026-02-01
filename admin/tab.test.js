/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

const repoRoot = path.resolve(__dirname, '..');
const adminDir = __dirname;

const FORBIDDEN_CLASS_TOKENS = [
	// Buttons / text
	'btn',
	'btn-flat',
	'btn-small',
	'red-text',
	'disabled',

	// Cards
	'card',
	'card-content',
	'card-title',

	// Progress
	'progress',
	'indeterminate',

	// Tables
	'striped',
	'highlight',

	// Forms / grid
	'input-field',
	'materialize-textarea',
	'row',
	'col',
	's12',
	'm8',
	'm4',
];

const FORBIDDEN_WORDS_ANYWHERE = ['materialize', 'materializecss'];

function escapeRe(s) {
	return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function listFilesRecursive(dir) {
	const out = [];
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const ent of entries) {
		const full = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			if (ent.name === 'i18n') {
				continue;
			}
			out.push(...(await listFilesRecursive(full)));
			continue;
		}
		if (ent.isFile()) {
			out.push(full);
		}
	}
	return out;
}

function computeLineStarts(text) {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			starts.push(i + 1);
		}
	}
	return starts;
}

function lineColFromIndex(lineStarts, idx) {
	let lo = 0;
	let hi = lineStarts.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const v = lineStarts[mid];
		if (v === idx) {
			lo = mid;
			break;
		}
		if (v < idx) {
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	const lineIdx = Math.max(0, lo - 1);
	return { line: lineIdx + 1, col: idx - lineStarts[lineIdx] + 1 };
}

function splitClassTokens(classValue) {
	return String(classValue || '')
		.split(/\s+/g)
		.map(s => s.trim())
		.filter(Boolean);
}

function checkClassValueTokens(tokens, relPath, pos, violations) {
	for (const token of FORBIDDEN_CLASS_TOKENS) {
		if (tokens.includes(token)) {
			violations.push({
				file: relPath,
				line: pos.line,
				col: pos.col,
				context: `forbidden class token '${token}'`,
			});
		}
	}
}

function findForbiddenWords(text, lineStarts, relPath, violations) {
	for (const word of FORBIDDEN_WORDS_ANYWHERE) {
		const re = new RegExp(`\\b${escapeRe(word)}\\b`, 'gi');
		let m;
		while ((m = re.exec(text))) {
			const pos = lineColFromIndex(lineStarts, m.index);
			violations.push({
				file: relPath,
				line: pos.line,
				col: pos.col,
				context: `forbidden word '${m[0]}'`,
			});
		}
	}
}

function scanHtml(text, lineStarts, relPath, violations) {
	const classAttrRe = /\bclass\s*=\s*(['"])(.*?)\1/gs;
	let m;
	while ((m = classAttrRe.exec(text))) {
		const pos = lineColFromIndex(lineStarts, m.index);
		checkClassValueTokens(splitClassTokens(m[2]), relPath, pos, violations);
	}
}

function scanCss(text, lineStarts, relPath, violations) {
	for (const token of FORBIDDEN_CLASS_TOKENS) {
		const re = new RegExp(`\\.${escapeRe(token)}(?![\\w-])`, 'g');
		let m;
		while ((m = re.exec(text))) {
			const pos = lineColFromIndex(lineStarts, m.index);
			violations.push({
				file: relPath,
				line: pos.line,
				col: pos.col,
				context: `forbidden CSS selector '.${token}'`,
			});
		}
	}
}

function scanJs(text, lineStarts, relPath, violations) {
	const classPropRes = [
		/\bclass\s*:\s*(['"])(.*?)\1/gs,
		/\bclass\s*:\s*`([\s\S]*?)`/g,
		/\bclassName\s*=\s*(['"])(.*?)\1/gs,
		/\bclassName\s*=\s*`([\s\S]*?)`/g,
	];

	for (const re of classPropRes) {
		let m;
		while ((m = re.exec(text))) {
			const idx = m.index;
			const raw = m.length >= 3 ? m[2] : m[1];
			const cleaned = String(raw).replace(/\$\{[^}]*\}/g, '');
			const pos = lineColFromIndex(lineStarts, idx);
			checkClassValueTokens(splitClassTokens(cleaned), relPath, pos, violations);
		}
	}

	// classList.add/remove/toggle/contains('token')
	const classListRe = /\bclassList\.(?:add|remove|toggle|contains)\s*\(([^)]*)\)/g;
	let m;
	while ((m = classListRe.exec(text))) {
		const idx = m.index;
		const args = m[1] || '';
		const strRe = /(['"`])([^'"`]*?)\1/g;
		let s;
		while ((s = strRe.exec(args))) {
			const value = s[2];
			if (FORBIDDEN_CLASS_TOKENS.includes(value)) {
				const pos = lineColFromIndex(lineStarts, idx);
				violations.push({
					file: relPath,
					line: pos.line,
					col: pos.col,
					context: `forbidden class token '${value}' (classList.*)`,
				});
			}
		}
	}

	// querySelector(All)/matches('.token')
	const selectorCallRe = /\b(?:querySelectorAll?|matches)\s*\(\s*(['"`])([\s\S]*?)\1/g;
	while ((m = selectorCallRe.exec(text))) {
		const idx = m.index;
		const selector = String(m[2] || '').replace(/\$\{[^}]*\}/g, '');
		for (const token of FORBIDDEN_CLASS_TOKENS) {
			const re = new RegExp(`(^|[^\\w-])\\.${escapeRe(token)}(?![\\w-])`);
			if (re.test(selector)) {
				const pos = lineColFromIndex(lineStarts, idx);
				violations.push({
					file: relPath,
					line: pos.line,
					col: pos.col,
					context: `forbidden selector '.${token}'`,
				});
			}
		}
	}
}

describe('AdminTab UI', function () {
	it('does not use Materialize tokens/classes', async function () {
		const files = await listFilesRecursive(adminDir);
		const candidates = files.filter(f => {
			const ext = path.extname(f).toLowerCase();
			if (f.endsWith('.test.js')) {
				return false;
			}
			return ext === '.js' || ext === '.html' || ext === '.css';
		});

		const violations = [];

		for (const file of candidates) {
			const relPath = path.relative(repoRoot, file);
			const text = await fs.readFile(file, 'utf8');
			const lineStarts = computeLineStarts(text);

			findForbiddenWords(text, lineStarts, relPath, violations);

			const ext = path.extname(file).toLowerCase();
			if (ext === '.html') {
				scanHtml(text, lineStarts, relPath, violations);
			} else if (ext === '.css') {
				scanCss(text, lineStarts, relPath, violations);
			} else if (ext === '.js') {
				scanJs(text, lineStarts, relPath, violations);
			}
		}

		if (violations.length) {
			const msg = violations.map(v => `- ${v.file}:${v.line}:${v.col} ${v.context}`).join('\n');
			assert.fail(`Materialize usage found in admin UI:\n${msg}\nTotal: ${violations.length}`);
		}
	});
});
