'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');

async function readRepoFile(relPath) {
	return fs.readFile(path.join(repoRoot, relPath), 'utf8');
}

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

function runInSandbox(source, sandbox, filename = 'inline.js') {
	const context = vm.createContext({ ...sandbox });
	vm.runInContext(source, context, { filename });
	return context;
}

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
