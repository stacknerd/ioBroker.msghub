'use strict';

// loadI18nDir — synchronous loader for backend i18n language directories.
//
// Loads all known <lang>.json files from a directory and returns a
// wordsByLang[lang][key] map suitable for IoRuntimeI18n.addSource().
//
// Uses require() (CJS cache) — correct for immutable deploy-time artifacts (A9).
//
// System: lib/loadI18nDir.js
// Interfaces: loadI18nDir(dir, log)
// Used by: main.js (_i18ninit), main.test.js

const fs = require('fs');
const path = require('path');

/**
 * Supported language codes, matching the repo-wide i18n convention.
 * Hardcoded for consistency with the existing loader in main.js.
 */
const LANGS = ['de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'ru', 'uk', 'zh-cn'];

/**
 * Loads all <lang>.json files from dir and returns a wordsByLang map.
 * Format: wordsByLang[lang][key] = translatedString
 *
 * Fail-fast on directory not found or JSON parse errors.
 * Warns and skips individual missing language files.
 * Warns and skips language entries whose JSON value is not a plain object.
 *
 * @param {string} dir - Absolute path to the directory containing <lang>.json files.
 * @param {{warn: Function}|null} [log] - Optional logger for per-language warnings.
 * @returns {{[lang: string]: {[key: string]: string}}} wordsByLang map.
 * @throws {Error} If the directory is not found, a JSON file contains a syntax error, or a JSON root value is not a plain object.
 */
function loadI18nDir(dir, log) {
	if (!fs.existsSync(dir)) {
		throw new Error(`Backend i18n dir not found: ${dir}`);
	}
	const wordsByLang = Object.create(null);
	for (const lang of LANGS) {
		const filePath = path.join(dir, `${lang}.json`);
		let data;
		try {
			data = require(filePath);
		} catch (e) {
			if (e && e.code === 'MODULE_NOT_FOUND') {
				log?.warn(`Backend i18n: missing language file, skipping: ${filePath}`);
				continue;
			}
			throw new Error(`JSON parse error in ${filePath}: ${e.message}`);
		}
		if (!data || typeof data !== 'object' || Array.isArray(data)) {
			throw new Error(`Expected plain object in ${filePath}`);
		}
		wordsByLang[lang] = data;
	}
	return wordsByLang;
}

module.exports = { loadI18nDir, LANGS };
