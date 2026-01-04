'use strict';

const { isObject } = require(`${__dirname}/../../src/MsgUtils`);

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

