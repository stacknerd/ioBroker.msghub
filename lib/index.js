'use strict';

const fs = require('fs');
const path = require('path');

const IoPluginsCategories = Object.freeze({
	ingest: 'ingest',
	notify: 'notify',
	bridge: 'bridge',
	engage: 'engage',
});

/**
 * IoPlugins catalog
 * -------------
 * Runtime plugin discovery (autodiscovery)
 * ---------------------------------------
 * Plugins live in `lib/<PluginType>/` directories and must export:
 * - `manifest` (object) with at least `{ type: string }`
 * - a factory function named exactly like `manifest.type` (e.g. `exports.NotifyStates = function ...`)
 *
 * The catalog is built at runtime by scanning `lib/<plugin>/manifest.js`.
 * This keeps the adapter restart-less + build-step-free while avoiding manual catalog wiring.
 *
 * Catalog entry shape
 * - `type`: stable string identifier used in config and in registration IDs.
 *   Convention: `type` is the literal factory/implementation name and therefore starts with `Ingest`, `Notify` or `Bridge`
 *   (e.g. `IngestStates`, `NotifyStates`).
 * - `label`: dev-facing label (informational only; no admin UI wiring).
 * - `defaultEnabled`: whether a new adapter instance enables the type by default.
 * - `supportsMultiple`: future flag to allow more than one instanceId per type.
 * - `options`: option schema (source of truth), includes per-key defaults used to seed `obj.native` on first creation.
 * - `create(options)`: factory that returns a plugin handler instance.
 */

function inferCategoryFromType(type) {
	const t = typeof type === 'string' ? type.trim() : '';
	if (!t) {
		throw new Error('IoPluginsCatalog: manifest.type is required');
	}
	if (/^Ingest/.test(t)) {
		return IoPluginsCategories.ingest;
	}
	if (/^Notify/.test(t)) {
		return IoPluginsCategories.notify;
	}
	if (/^Bridge/.test(t)) {
		return IoPluginsCategories.bridge;
	}
	if (/^Engage/.test(t)) {
		return IoPluginsCategories.engage;
	}
	throw new Error(`IoPluginsCatalog: cannot infer category from type '${t}'`);
}

function discoverPlugins() {
	const plugins = [];
	const entries = fs.readdirSync(__dirname, { withFileTypes: true });

	const isValidCategory = v =>
		v === IoPluginsCategories.ingest ||
		v === IoPluginsCategories.notify ||
		v === IoPluginsCategories.bridge ||
		v === IoPluginsCategories.engage;

	for (const entry of entries) {
		if (!entry?.isDirectory?.()) {
			continue;
		}
		const dir = entry.name;
		if (!dir || dir.startsWith('.') || dir === 'node_modules') {
			continue;
		}

		const manifestPath = path.join(__dirname, dir, 'manifest.js');
		if (!fs.existsSync(manifestPath)) {
			continue;
		}

		// Load manifest from `manifest.js` so we can skip plugins without requiring their full module.
		const manifestMod = require(`./${dir}/manifest`);
		const manifest = manifestMod?.manifest;
		if (!manifest || typeof manifest !== 'object') {
			throw new Error(`IoPluginsCatalog: '${dir}' has manifest.js but does not export { manifest }`);
		}

		// Allow hiding/disabling plugins from runtime discovery without deleting code.
		// This is useful for deprecated or internal-only plugins.
		if (manifest.hidden === true || manifest.discoverable === false) {
			continue;
		}

		const type = typeof manifest.type === 'string' ? manifest.type.trim() : '';
		if (!type) {
			throw new Error(`IoPluginsCatalog: '${dir}' manifest.type is required`);
		}

		const mod = require(`./${dir}`);
		const create = mod?.[type];
		if (typeof create !== 'function') {
			throw new Error(`IoPluginsCatalog: '${dir}' must export a factory function named '${type}'`);
		}

		const category = manifest.category ? String(manifest.category).trim() : inferCategoryFromType(type);
		if (!isValidCategory(category)) {
			throw new Error(`IoPluginsCatalog: '${dir}' has invalid category '${category}'`);
		}

		plugins.push({ dir, category, type, manifest, create });
	}

	return plugins;
}

function buildCatalog(discovered) {
	const ingest = [];
	const notify = [];
	const bridge = [];
	const engage = [];

	const byCategory = {
		[IoPluginsCategories.ingest]: ingest,
		[IoPluginsCategories.notify]: notify,
		[IoPluginsCategories.bridge]: bridge,
		[IoPluginsCategories.engage]: engage,
	};

	for (const p of discovered) {
		byCategory[p.category].push({ ...p.manifest, create: p.create });
	}

	for (const category of Object.values(IoPluginsCategories)) {
		byCategory[category].sort((a, b) => String(a?.type || '').localeCompare(String(b?.type || '')));
	}

	return Object.freeze({
		[IoPluginsCategories.ingest]: Object.freeze(ingest),
		[IoPluginsCategories.notify]: Object.freeze(notify),
		[IoPluginsCategories.bridge]: Object.freeze(bridge),
		[IoPluginsCategories.engage]: Object.freeze(engage),
	});
}

const discoveredPlugins = discoverPlugins();
const IoPluginsCatalog = buildCatalog(discoveredPlugins);

// Also export discovered factories by name (keeps `require('.../lib').NotifyStates` style imports working).
const exportedFactories = {};
for (const p of discoveredPlugins) {
	exportedFactories[p.type] = p.create;
}

module.exports = {
	IoPluginsCategories,
	IoPluginsCatalog,
	...exportedFactories,
};
