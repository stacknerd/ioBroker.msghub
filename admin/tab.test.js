/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

const repoRoot = path.resolve(__dirname, '..');
const adminDir = __dirname;
const panelsDir = path.join(adminDir, 'tab', 'panels');

const FORBIDDEN_CLASS_TOKENS = [
	'btn',
	'btn-flat',
	'btn-small',
	'red-text',
	'disabled',
	'card',
	'card-content',
	'card-title',
	'progress',
	'indeterminate',
	'striped',
	'highlight',
	'input-field',
	'materialize-textarea',
	'row',
	'col',
	's12',
	'm8',
	'm4',
];

const FORBIDDEN_WORDS_ANYWHERE = ['materialize', 'materializecss'];

function escapeRe(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function listFilesRecursive(directory) {
	const out = [];
	const entries = await fs.readdir(directory, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'i18n') {
				continue;
			}
			out.push(...(await listFilesRecursive(fullPath)));
			continue;
		}
		if (entry.isFile()) {
			out.push(fullPath);
		}
	}
	return out;
}

function computeLineStarts(text) {
	const starts = [0];
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) === 10) {
			starts.push(index + 1);
		}
	}
	return starts;
}

function lineColFromIndex(lineStarts, index) {
	let lower = 0;
	let upper = lineStarts.length - 1;
	while (lower <= upper) {
		const middle = (lower + upper) >> 1;
		const value = lineStarts[middle];
		if (value === index) {
			lower = middle;
			break;
		}
		if (value < index) {
			lower = middle + 1;
		} else {
			upper = middle - 1;
		}
	}
	const lineIndex = Math.max(0, lower - 1);
	return { line: lineIndex + 1, col: index - lineStarts[lineIndex] + 1 };
}

function splitClassTokens(classValue) {
	return String(classValue || '')
		.split(/\s+/g)
		.map(token => token.trim())
		.filter(Boolean);
}

function checkClassTokens(tokens, relPath, pos, violations) {
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

function scanForbiddenWords(text, lineStarts, relPath, violations) {
	for (const word of FORBIDDEN_WORDS_ANYWHERE) {
		const re = new RegExp(`\\b${escapeRe(word)}\\b`, 'gi');
		let match;
		while ((match = re.exec(text))) {
			const pos = lineColFromIndex(lineStarts, match.index);
			violations.push({
				file: relPath,
				line: pos.line,
				col: pos.col,
				context: `forbidden word '${match[0]}'`,
			});
		}
	}
}

function scanHtmlForClasses(text, lineStarts, relPath, violations) {
	const classAttrRe = /\bclass\s*=\s*(['"])(.*?)\1/gs;
	let match;
	while ((match = classAttrRe.exec(text))) {
		const pos = lineColFromIndex(lineStarts, match.index);
		checkClassTokens(splitClassTokens(match[2]), relPath, pos, violations);
	}
}

function scanCssForClasses(text, lineStarts, relPath, violations) {
	for (const token of FORBIDDEN_CLASS_TOKENS) {
		const re = new RegExp(`\\.${escapeRe(token)}(?![\\w-])`, 'g');
		let match;
		while ((match = re.exec(text))) {
			const pos = lineColFromIndex(lineStarts, match.index);
			violations.push({
				file: relPath,
				line: pos.line,
				col: pos.col,
				context: `forbidden CSS selector '.${token}'`,
			});
		}
	}
}

function scanJsForClasses(text, lineStarts, relPath, violations) {
	const classPropRes = [
		/\bclass\s*:\s*(['"])(.*?)\1/gs,
		/\bclass\s*:\s*`([\s\S]*?)`/g,
		/\bclassName\s*=\s*(['"])(.*?)\1/gs,
		/\bclassName\s*=\s*`([\s\S]*?)`/g,
	];

	for (const re of classPropRes) {
		let match;
		while ((match = re.exec(text))) {
			const index = match.index;
			const raw = match.length >= 3 ? match[2] : match[1];
			const cleaned = String(raw).replace(/\$\{[^}]*\}/g, '');
			const pos = lineColFromIndex(lineStarts, index);
			checkClassTokens(splitClassTokens(cleaned), relPath, pos, violations);
		}
	}

	const classListRe = /\bclassList\.(?:add|remove|toggle|contains)\s*\(([^)]*)\)/g;
	let match;
	while ((match = classListRe.exec(text))) {
		const index = match.index;
		const args = match[1] || '';
		const strRe = /(['"`])([^'"`]*?)\1/g;
		let valueMatch;
		while ((valueMatch = strRe.exec(args))) {
			const value = valueMatch[2];
			if (FORBIDDEN_CLASS_TOKENS.includes(value)) {
				const pos = lineColFromIndex(lineStarts, index);
				violations.push({
					file: relPath,
					line: pos.line,
					col: pos.col,
					context: `forbidden class token '${value}' (classList.*)`,
				});
			}
		}
	}

	const selectorCallRe = /\b(?:querySelectorAll?|matches)\s*\(\s*(['"`])([\s\S]*?)\1/g;
	while ((match = selectorCallRe.exec(text))) {
		const index = match.index;
		const selector = String(match[2] || '').replace(/\$\{[^}]*\}/g, '');
		for (const token of FORBIDDEN_CLASS_TOKENS) {
			const re = new RegExp(`(^|[^\\w-])\\.${escapeRe(token)}(?![\\w-])`);
			if (re.test(selector)) {
				const pos = lineColFromIndex(lineStarts, index);
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

describe('AdminTab Governance Integration', function () {
	it('does not use Materialize tokens/classes in admin UI', async function () {
		const files = await listFilesRecursive(adminDir);
		const candidates = files.filter(file => {
			if (file.endsWith('.test.js')) {
				return false;
			}
			const ext = path.extname(file).toLowerCase();
			return ext === '.js' || ext === '.html' || ext === '.css';
		});

		const violations = [];
		for (const file of candidates) {
			const relPath = path.relative(repoRoot, file);
			const text = await fs.readFile(file, 'utf8');
			const lineStarts = computeLineStarts(text);
			scanForbiddenWords(text, lineStarts, relPath, violations);

			const ext = path.extname(file).toLowerCase();
			if (ext === '.html') {
				scanHtmlForClasses(text, lineStarts, relPath, violations);
			} else if (ext === '.css') {
				scanCssForClasses(text, lineStarts, relPath, violations);
			} else if (ext === '.js') {
				scanJsForClasses(text, lineStarts, relPath, violations);
			}
		}

		if (violations.length) {
			const message = violations.map(violation => `- ${violation.file}:${violation.line}:${violation.col} ${violation.context}`).join('\n');
			assert.fail(`Materialize usage found in admin UI:\n${message}\nTotal: ${violations.length}`);
		}
	});

	it('panel/module css is tokens-only (no hardcoded colors)', async function () {
		const files = await listFilesRecursive(panelsDir);
		const cssFiles = files.filter(file => path.extname(file).toLowerCase() === '.css');

		const violations = [];
		const reHex = /#[0-9a-fA-F]{3,8}\b/g;
		const reRgb = /\brgba?\s*\(/gi;
		const reHsl = /\bhsla?\s*\(/gi;

		for (const file of cssFiles) {
			const relPath = path.relative(repoRoot, file);
			const text = await fs.readFile(file, 'utf8');
			const lineStarts = computeLineStarts(text);

			let match;
			while ((match = reHex.exec(text))) {
				const pos = lineColFromIndex(lineStarts, match.index);
				violations.push({ file: relPath, line: pos.line, col: pos.col, context: `hardcoded color '${match[0]}'` });
			}
			while ((match = reRgb.exec(text))) {
				const pos = lineColFromIndex(lineStarts, match.index);
				violations.push({
					file: relPath,
					line: pos.line,
					col: pos.col,
					context: `hardcoded color function '${match[0]}'`,
				});
			}
			while ((match = reHsl.exec(text))) {
				const pos = lineColFromIndex(lineStarts, match.index);
				violations.push({
					file: relPath,
					line: pos.line,
					col: pos.col,
					context: `hardcoded color function '${match[0]}'`,
				});
			}
		}

		if (violations.length) {
			const message = violations.map(violation => `- ${violation.file}:${violation.line}:${violation.col} ${violation.context}`).join('\n');
			assert.fail(`Hardcoded colors found in panel/module CSS (use tokens from admin/tab/tokens.css):\n${message}\nTotal: ${violations.length}`);
		}
	});

	it('does not implement contextmenu DOM in panels', async function () {
		const files = await listFilesRecursive(panelsDir);
		const candidates = files.filter(file => {
			if (file.endsWith('.test.js')) {
				return false;
			}
			const ext = path.extname(file).toLowerCase();
			return ext === '.js' || ext === '.html' || ext === '.css';
		});

		const violations = [];
		for (const file of candidates) {
			const relPath = path.relative(repoRoot, file);
			const text = await fs.readFile(file, 'utf8');
			const index = text.indexOf('msghub-contextmenu');
			if (index >= 0) {
				const lineStarts = computeLineStarts(text);
				const pos = lineColFromIndex(lineStarts, index);
				violations.push({
					file: relPath,
					line: pos.line,
					col: pos.col,
					context: "forbidden contextmenu DOM token 'msghub-contextmenu' (use ctx.api.ui.contextMenu)",
				});
			}
		}

		if (violations.length) {
			const message = violations.map(violation => `- ${violation.file}:${violation.line}:${violation.col} ${violation.context}`).join('\n');
			assert.fail(`ContextMenu primitive must be core-only:\n${message}\nTotal: ${violations.length}`);
		}
	});

	it('does not use admin sendTo outside the API layer', async function () {
		const files = await listFilesRecursive(panelsDir);
		const candidates = files.filter(file => !file.endsWith('.test.js') && path.extname(file).toLowerCase() === '.js');

		const violations = [];
		for (const file of candidates) {
			const relPath = path.relative(repoRoot, file);
			const text = await fs.readFile(file, 'utf8');
			const lineStarts = computeLineStarts(text);

			const needleDirect = "sendTo('admin";
			const directIndex = text.indexOf(needleDirect);
			if (directIndex >= 0) {
				const pos = lineColFromIndex(lineStarts, directIndex);
				violations.push({ file: relPath, line: pos.line, col: pos.col, context: `found ${needleDirect}` });
			}

			const needleContext = 'ctx.sendTo';
			const contextIndex = text.indexOf(needleContext);
			if (contextIndex >= 0) {
				const pos = lineColFromIndex(lineStarts, contextIndex);
				violations.push({ file: relPath, line: pos.line, col: pos.col, context: `found ${needleContext}` });
			}
		}

		if (violations.length) {
			const message = violations.map(violation => `${violation.file}:${violation.line}:${violation.col} ${violation.context}`).join('\n');
			assert.fail(`Forbidden direct backend calls in panels:\n${message}`);
		}
	});
});
