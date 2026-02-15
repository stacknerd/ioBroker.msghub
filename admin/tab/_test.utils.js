'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * Admin tab core test utility module.
 *
 * Provides shared helpers for core-admin tests and panel-local test utilities.
 * The helpers encapsulate repo file access, function-source extraction, sandbox
 * execution, and storage mocks for deterministic unit tests.
 */

/**
 * Reads a UTF-8 file by repository-relative path.
 *
 * @param {string} relPath Repository-relative file path.
 * @returns {Promise<string>} File contents as UTF-8 text.
 */
async function readRepoFile(relPath) {
	return fs.readFile(path.join(repoRoot, relPath), 'utf8');
}

/**
 * Finds the matching closing brace index for an opening brace.
 *
 * @param {string} source Source code text.
 * @param {number} openBraceIndex Index of opening brace.
 * @returns {number} Index of matching closing brace.
 */
function findMatchingBrace(source, openBraceIndex) {
	let depth = 0;
	let inSingle = false;
	let inDouble = false;
	let inTemplate = false;
	let inLineComment = false;
	let inBlockComment = false;
	let escaped = false;

	for (let index = openBraceIndex; index < source.length; index++) {
		const char = source[index];
		const next = source[index + 1];

		if (inLineComment) {
			if (char === '\n') {
				inLineComment = false;
			}
			continue;
		}
		if (inBlockComment) {
			if (char === '*' && next === '/') {
				inBlockComment = false;
				index++;
			}
			continue;
		}

		if (inSingle || inDouble || inTemplate) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === '\\') {
				escaped = true;
				continue;
			}
			if (inSingle && char === "'") {
				inSingle = false;
				continue;
			}
			if (inDouble && char === '"') {
				inDouble = false;
				continue;
			}
			if (inTemplate && char === '`') {
				inTemplate = false;
				continue;
			}
			continue;
		}

		if (char === '/' && next === '/') {
			inLineComment = true;
			index++;
			continue;
		}
		if (char === '/' && next === '*') {
			inBlockComment = true;
			index++;
			continue;
		}

		if (char === "'") {
			inSingle = true;
			continue;
		}
		if (char === '"') {
			inDouble = true;
			continue;
		}
		if (char === '`') {
			inTemplate = true;
			continue;
		}

		if (char === '{') {
			depth++;
			continue;
		}
		if (char === '}') {
			depth--;
			if (depth === 0) {
				return index;
			}
		}
	}

	throw new Error(`No matching brace found at index ${openBraceIndex}`);
}

/**
 * Extracts a full function declaration source by function name.
 *
 * @param {string} source Source code text.
 * @param {string} functionName Function declaration name.
 * @returns {string} Full function source including body.
 */
function extractFunctionSource(source, functionName) {
	const pattern = new RegExp(`function\\s+${functionName}\\s*\\(`);
	const match = pattern.exec(source);
	if (!match) {
		throw new Error(`Function '${functionName}' not found`);
	}
	const startIndex = match.index;
	const braceIndex = source.indexOf('{', startIndex);
	if (braceIndex < 0) {
		throw new Error(`Function '${functionName}' has no body`);
	}
	const endIndex = findMatchingBrace(source, braceIndex);
	return source.slice(startIndex, endIndex + 1);
}

/**
 * Executes source code in an isolated VM context.
 *
 * @param {string} source JavaScript source code.
 * @param {object} sandbox Globals for the context.
 * @param {string} [filename] Virtual filename for stack traces.
 * @returns {object} VM context object.
 */
function runInSandbox(source, sandbox, filename = 'inline.js') {
	const context = vm.createContext({ ...sandbox });
	vm.runInContext(source, context, { filename });
	return context;
}

/**
 * Creates a storage mock compatible with session/local storage APIs.
 *
 * @param {Record<string, string>} [initial] Initial key/value entries.
 * @returns {{getItem:Function,setItem:Function,removeItem:Function,clear:Function}} Storage facade.
 */
function createStorage(initial = {}) {
	const store = new Map(Object.entries(initial));
	return {
		getItem: key => (store.has(String(key)) ? store.get(String(key)) : null),
		setItem: (key, value) => {
			store.set(String(key), String(value));
		},
		removeItem: key => {
			store.delete(String(key));
		},
		clear: () => {
			store.clear();
		},
	};
}

module.exports = {
	repoRoot,
	readRepoFile,
	extractFunctionSource,
	runInSandbox,
	createStorage,
};
