'use strict';

/**
 * Skeleton for loop protection helpers (ignore customs on own objects).
 *
 * @param {string} namespace Adapter namespace, e.g. "msghub.0"
 * @param {string} id Object id
 * @returns {boolean}
 */
function isOwnObjectId(namespace, id) {
	return id === namespace || String(id).startsWith(`${namespace}.`);
}

module.exports = { isOwnObjectId };

