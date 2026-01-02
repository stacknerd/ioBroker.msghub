'use strict';

/**
 * @param {any} v Value.
 * @returns {boolean} True when v is a plain object-like value.
 */
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Strip the `ctx.` prefix from a guard path (if present).
 *
 * @param {any} path Path string (e.g. `ctx.api.log`).
 * @returns {any} Normalized path (without `ctx.`).
 */
const normalizePath = path => (typeof path === 'string' && path.startsWith('ctx.') ? path.slice(4) : path);

/**
 * Resolve a dotted path (optionally starting with `ctx.`) from a root object.
 *
 * @param {any} root Root object.
 * @param {any} path Dotted path string.
 * @returns {any} Resolved value or `undefined`.
 */
const getPath = (root, path) => {
	const p = normalizePath(path);
	if (typeof p !== 'string' || !p.trim()) {
		return undefined;
	}

	let acc = root;
	for (const key of p.split('.')) {
		if (!key) {
			return undefined;
		}
		if (!isPlainObject(acc)) {
			return undefined;
		}
		acc = acc[key];
	}
	return acc;
};

/**
 * Validate that `ctx` provides a minimum set of members required by a plugin.
 *
 * @param {string} prefix Error prefix (e.g. `IngestHue.start`).
 * @param {any} ctx Context object.
 * @param {object} [req] Requirements.
 * @param {string[]} [req.plainObject] Paths that must resolve to a plain object.
 * @param {string[]} [req.fn] Paths that must resolve to a function.
 * @param {string[]} [req.stringNonEmpty] Paths that must resolve to a non-empty string.
 * @returns {any} The input ctx (for convenience).
 */
const ensureCtxAvailability = (prefix, ctx, req = {}) => {
	if (!isPlainObject(ctx)) {
		throw new Error(`${prefix}: ctx must be a plain object`);
	}

	const plainObjectPaths = Array.isArray(req.plainObject) ? req.plainObject : [];
	for (const path of plainObjectPaths) {
		const v = getPath(ctx, path);
		if (!isPlainObject(v)) {
			throw new Error(`${prefix}: ${normalizePath(path)} must be a plain object`);
		}
	}

	const fnPaths = Array.isArray(req.fn) ? req.fn : [];
	for (const path of fnPaths) {
		const v = getPath(ctx, path);
		if (typeof v !== 'function') {
			throw new Error(`${prefix}: ${normalizePath(path)} must be a function`);
		}
	}

	const nonEmptyStringPaths = Array.isArray(req.stringNonEmpty) ? req.stringNonEmpty : [];
	for (const path of nonEmptyStringPaths) {
		const v = getPath(ctx, path);
		if (typeof v !== 'string' || !v.trim()) {
			throw new Error(`${prefix}: ${normalizePath(path)} must be a non-empty string`);
		}
	}

	return ctx;
};

module.exports = { isPlainObject, getPath, ensureCtxAvailability };
