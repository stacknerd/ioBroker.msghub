'use strict';

function isOwnObjectId(namespace, id) {
	return id === namespace || String(id).startsWith(`${namespace}.`);
}

module.exports = { isOwnObjectId };

