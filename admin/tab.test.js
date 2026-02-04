/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const vm = require('node:vm');

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

	it('panel/module css is tokens-only (no hardcoded colors)', async function () {
		const files = await fs.readdir(adminDir);
		const cssFiles = files
			.filter(f => f.endsWith('.css'))
			.map(f => path.join(adminDir, f))
			.filter(f => path.basename(f) !== 'tab.css');

		const violations = [];
		const reHex = /#[0-9a-fA-F]{3,8}\b/g;
		const reRgb = /\brgba?\s*\(/gi;
		const reHsl = /\bhsla?\s*\(/gi;

		for (const file of cssFiles) {
			const relPath = path.relative(repoRoot, file);
			const text = await fs.readFile(file, 'utf8');
			const lineStarts = computeLineStarts(text);

			let m;
			while ((m = reHex.exec(text))) {
				const pos = lineColFromIndex(lineStarts, m.index);
				violations.push({ file: relPath, line: pos.line, col: pos.col, context: `hardcoded color '${m[0]}'` });
			}
			while ((m = reRgb.exec(text))) {
				const pos = lineColFromIndex(lineStarts, m.index);
				violations.push({ file: relPath, line: pos.line, col: pos.col, context: `hardcoded color function '${m[0]}'` });
			}
			while ((m = reHsl.exec(text))) {
				const pos = lineColFromIndex(lineStarts, m.index);
				violations.push({ file: relPath, line: pos.line, col: pos.col, context: `hardcoded color function '${m[0]}'` });
			}
		}

		if (violations.length) {
			const msg = violations.map(v => `- ${v.file}:${v.line}:${v.col} ${v.context}`).join('\n');
			assert.fail(`Hardcoded colors found in panel/module CSS (use tokens from admin/tab.css):\n${msg}\nTotal: ${violations.length}`);
		}
	});

	it('registry is consistent (panels, compositions, assets)', async function () {
		const tabJsPath = path.join(adminDir, 'tab.js');
		const src = await fs.readFile(tabJsPath, 'utf8');

		const idx = src.indexOf('MsghubAdminTabRegistry');
		assert.ok(idx >= 0, 'Expected MsghubAdminTabRegistry to exist in admin/tab.js');

		const start = src.lastIndexOf('(() => {', idx);
		assert.ok(start >= 0, 'Expected registry IIFE start in admin/tab.js');

		const end = src.indexOf('})();', idx);
		assert.ok(end >= 0, 'Expected registry IIFE end in admin/tab.js');

		const snippet = src.slice(start, end + '})();'.length);
		const sandbox = { window: {}, win: null, console: { debug() {}, info() {}, warn() {}, error() {} } };
		sandbox.win = sandbox.window;
		vm.runInNewContext(snippet, sandbox, { filename: 'admin/tab.js (registry snippet)' });

		const registry = sandbox.window.MsghubAdminTabRegistry;
		assert.ok(registry && typeof registry === 'object', 'Expected registry to be an object');
		assert.ok(registry.panels && typeof registry.panels === 'object', 'Expected registry.panels');
		assert.ok(registry.compositions && typeof registry.compositions === 'object', 'Expected registry.compositions');

		const panels = registry.panels;
		const compositions = registry.compositions;

		const mountIds = new Set();
		for (const [id, def] of Object.entries(panels)) {
			assert.ok(id && typeof id === 'string', 'Panel id must be a string');
			assert.ok(def && typeof def === 'object', `Panel '${id}' must be an object`);
			assert.equal(def.id, id, `Panel '${id}' must have matching .id`);
			assert.ok(typeof def.mountId === 'string' && def.mountId.trim(), `Panel '${id}' must have mountId`);
			assert.ok(typeof def.initGlobal === 'string' && def.initGlobal.trim(), `Panel '${id}' must have initGlobal`);
			assert.ok(def.assets && typeof def.assets === 'object', `Panel '${id}' must have assets`);
			assert.ok(Array.isArray(def.assets.css), `Panel '${id}' assets.css must be array`);
			assert.ok(Array.isArray(def.assets.js), `Panel '${id}' assets.js must be array`);

			assert.ok(!mountIds.has(def.mountId), `Duplicate mountId '${def.mountId}'`);
			mountIds.add(def.mountId);

			for (const rel of [...def.assets.css, ...def.assets.js]) {
				assert.ok(typeof rel === 'string' && rel.trim(), `Panel '${id}' asset entries must be strings`);
				const full = path.join(adminDir, rel);
				try {
					await fs.access(full);
				} catch {
					assert.fail(`Missing asset for panel '${id}': ${rel}`);
				}
			}
		}

		for (const [cid, comp] of Object.entries(compositions)) {
			assert.ok(cid && typeof cid === 'string', 'Composition id must be a string');
			assert.ok(comp && typeof comp === 'object', `Composition '${cid}' must be an object`);
			assert.equal(comp.id, cid, `Composition '${cid}' must have matching .id`);
			assert.ok(comp.layout === 'tabs' || comp.layout === 'single', `Composition '${cid}' has invalid layout`);
			assert.ok(Array.isArray(comp.panels), `Composition '${cid}' must have panels[]`);

			for (const pid of comp.panels) {
				assert.ok(typeof pid === 'string' && pid.trim(), `Composition '${cid}' panel ids must be strings`);
				assert.ok(panels[pid], `Composition '${cid}' references unknown panel '${pid}'`);
			}

			assert.ok(typeof comp.defaultPanel === 'string' && comp.defaultPanel.trim(), `Composition '${cid}' must have defaultPanel`);
			assert.ok(
				comp.panels.includes(comp.defaultPanel),
				`Composition '${cid}' defaultPanel '${comp.defaultPanel}' must be in panels[]`,
			);

			if (comp.deviceMode != null) {
				assert.ok(
					comp.deviceMode === 'pc' || comp.deviceMode === 'mobile' || comp.deviceMode === 'screenOnly',
					`Composition '${cid}' has invalid deviceMode`,
				);
			}
		}
	});

	it('exposes contextMenu API on ctx.api.ui (phase 1)', async function () {
		const tabJsPath = path.join(adminDir, 'tab.js');
		const src = await fs.readFile(tabJsPath, 'utf8');

		assert.match(
			src,
			/\bcontextMenu\s*:\s*Object\.freeze\s*\(\s*\{\s*open\s*:\s*opts\s*=>/m,
			'Expected ctx.api.ui.contextMenu to exist in admin/tab.js',
		);

		assert.match(
			src,
			/\breturn\s+Object\.freeze\s*\(\s*\{[\s\S]*?\bcontextMenu\s*,/m,
			'Expected createUi\\(\\) to return the contextMenu primitive',
		);
	});

	it('does not implement contextmenu DOM in panels (use ctx.api.ui.contextMenu)', async function () {
		const files = await listFilesRecursive(adminDir);
		const candidates = files.filter(f => {
			if (f.endsWith('.test.js')) {
				return false;
			}
			const ext = path.extname(f).toLowerCase();
			return ext === '.js' || ext === '.html' || ext === '.css';
		});

		const violations = [];
		for (const file of candidates) {
			const base = path.basename(file);
			if (base === 'tab.js' || base === 'tab.css' || base === 'tab.html') {
				continue;
			}
			const relPath = path.relative(repoRoot, file);
			const text = await fs.readFile(file, 'utf8');
			const idx = text.indexOf('msghub-contextmenu');
			if (idx >= 0) {
				const lineStarts = computeLineStarts(text);
				const pos = lineColFromIndex(lineStarts, idx);
				violations.push({
					file: relPath,
					line: pos.line,
					col: pos.col,
					context: "Forbidden contextmenu DOM token 'msghub-contextmenu' (use ctx.api.ui.contextMenu)",
				});
			}
		}

		if (violations.length) {
			const msg = violations.map(v => `- ${v.file}:${v.line}:${v.col} ${v.context}`).join('\n');
			assert.fail(`ContextMenu primitive must be core-only:\n${msg}\nTotal: ${violations.length}`);
		}
	});

	it('context menu clamp algorithm is deterministic (pure function)', async function () {
		const tabJsPath = path.join(adminDir, 'tab.js');
		const src = await fs.readFile(tabJsPath, 'utf8');

		const idx = src.indexOf('function computeContextMenuPosition');
		assert.ok(idx >= 0, 'Expected computeContextMenuPosition() to exist in admin/tab.js');

		const end = src.indexOf('\n}\n', idx);
		assert.ok(end >= 0, 'Expected end of computeContextMenuPosition()');

		const snippet = `${src.slice(idx, end + 3)}\nwindow.computeContextMenuPosition = computeContextMenuPosition;\n`;
		const sandbox = { window: {} };
		vm.runInNewContext(snippet, sandbox, { filename: 'admin/tab.js (computeContextMenuPosition snippet)' });

		const fn = sandbox.window.computeContextMenuPosition;
		assert.equal(typeof fn, 'function', 'Expected computeContextMenuPosition to be a function');

		// Case 1: fits bottom-right.
		const p1 = fn({
			anchorX: 100,
			anchorY: 100,
			menuWidth: 200,
			menuHeight: 120,
			viewportWidth: 800,
			viewportHeight: 600,
			mode: 'cursor',
			viewportPadding: 8,
			cursorOffset: 2,
		});
		assert.equal(p1.x, 102);
		assert.equal(p1.y, 102);

		// Case 2: near bottom-right, should flip left/up.
		const p2 = fn({
			anchorX: 790,
			anchorY: 590,
			menuWidth: 240,
			menuHeight: 140,
			viewportWidth: 800,
			viewportHeight: 600,
			mode: 'cursor',
			viewportPadding: 8,
			cursorOffset: 2,
		});
		assert.ok(p2.x < 790, 'Expected flip to left');
		assert.ok(p2.y < 590, 'Expected flip to top');
		assert.ok(p2.x >= 8 && p2.y >= 8, 'Expected clamped to viewport padding');

		// Case 3: submenu aligns to parent top when there is room, otherwise clamps.
		const p3 = fn({
			anchorX: 700,
			anchorY: 20,
			menuWidth: 200,
			menuHeight: 300,
			viewportWidth: 800,
			viewportHeight: 200,
			mode: 'submenu',
			alignHeight: 24,
			viewportPadding: 8,
			cursorOffset: 2,
		});
		assert.ok(p3.x <= 700, 'Expected submenu to clamp/flip if needed');
		assert.ok(p3.y >= 8, 'Expected submenu y to be clamped');
	});

	it('context menu supports primary menu items (core-only styling hook)', async function () {
		const tabJsPath = path.join(adminDir, 'tab.js');
		const src = await fs.readFile(tabJsPath, 'utf8');
		assert.match(src, /\bitem\.primary\s*===\s*true\b/, 'Expected primary flag check in admin/tab.js contextmenu renderer');
		assert.match(src, /classList\.add\(\s*['"]is-primary['"]\s*\)/, "Expected class 'is-primary' to be applied");
	});

	it('does not use admin sendTo outside the API layer', async function () {
		const files = await listFilesRecursive(adminDir);
		const candidates = files.filter(f => {
			if (f.endsWith('.test.js')) {
				return false;
			}
			return path.extname(f).toLowerCase() === '.js';
		});

		const violations = [];
		for (const file of candidates) {
			if (path.basename(file) === 'tab.js') {
				continue;
			}
			const relPath = path.relative(repoRoot, file);
			const text = await fs.readFile(file, 'utf8');
			const lineStarts = computeLineStarts(text);

			const needle1 = "sendTo('admin";
			const idx1 = text.indexOf(needle1);
			if (idx1 >= 0) {
				const pos = lineColFromIndex(lineStarts, idx1);
				violations.push({ file: relPath, line: pos.line, col: pos.col, context: `found ${needle1}` });
			}

			const needle2 = 'ctx.sendTo';
			const idx2 = text.indexOf(needle2);
			if (idx2 >= 0) {
				const pos = lineColFromIndex(lineStarts, idx2);
				violations.push({ file: relPath, line: pos.line, col: pos.col, context: `found ${needle2}` });
			}
		}

		if (violations.length) {
			const lines = violations.map(v => `${v.file}:${v.line}:${v.col} ${v.context}`).join('\n');
			assert.fail(`Forbidden direct backend calls in panels:\n${lines}`);
		}
	});
});
