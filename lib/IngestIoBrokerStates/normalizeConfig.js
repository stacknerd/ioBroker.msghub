'use strict';

const { isObject } = require(`${__dirname}/../../src/MsgUtils`);

/**
 * Normalize an object by expanding dot-keys into nested objects.
 *
 * Example: `{ "a.b": 1 }` -> `{ a: { b: 1 } }`
 *
 * @param {unknown} input Raw input value.
 * @returns {unknown} Normalized value (non-objects are returned unchanged).
 */
function normalizeDotKeys(input) {
	if (!isObject(input)) {
		return input;
	}

	const out = {};

	for (const [key, value] of Object.entries(input)) {
		if (key.includes('.')) {
			continue;
		}
		out[key] = isObject(value) ? normalizeDotKeys(value) : value;
	}

	for (const [key, value] of Object.entries(input)) {
		if (!key.includes('.')) {
			continue;
		}
		const parts = key.split('.').filter(Boolean);
		if (parts.length === 0) {
			continue;
		}

		let cur = out;
		for (let i = 0; i < parts.length - 1; i += 1) {
			const p = parts[i];
			if (!isObject(cur[p])) {
				cur[p] = {};
			}
			cur = cur[p];
		}
		cur[parts[parts.length - 1]] = isObject(value) ? normalizeDotKeys(value) : value;
	}

	return out;
}

/**
 * Clone and normalize a rule config object.
 *
 * @param {unknown} cfg Raw config value.
 * @returns {Record<string, any>|null} Normalized config, or `null` when invalid.
 */
function normalizeRuleCfg(cfg) {
	if (!isObject(cfg)) {
		return null;
	}
	return normalizeDotKeys(JSON.parse(JSON.stringify(cfg)));
}

module.exports = {
	normalizeDotKeys,
	normalizeRuleCfg,
};
