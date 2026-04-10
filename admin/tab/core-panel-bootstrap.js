/* global window, document */
'use strict';
/* Docs: ../../docs/ui/tab-core-panel-bootstrap.md */

/**
 * Core Panel Bootstrap
 * ====================
 * Host-owned bootstrap resolver for AdminTab core panels.
 *
 * Docs: ../../docs/ui/tab-core-panel-bootstrap.md
 *
 * Responsibilities
 * - Resolve the conventional AdminTab core-panel entry URL from the owner-local panel key.
 * - Load `admin/tab/panels/<panelKey>/entry.js` exactly once per page lifetime.
 * - Validate and freeze the host-owned entry contract (`css`, `js`, `panelInit(ctx)`).
 *
 * Non-responsibilities
 * - No backend view resolution -> owned by `IoUiCatalog`.
 * - No layout/DOM composition decisions -> owned by `layout.js`.
 * - No panel lifecycle execution -> owned by `boot.js`.
 */

/**
 * Promise cache for conventional core-panel entry loads.
 *
 * Keys are owner-local core panel ids such as `messages` or `plugins`.
 * Values are the in-flight or resolved `loadCorePanelEntry(...)` promises.
 *
 */
const corePanelEntryPromises = new Map();

/**
 * Normalizes one owner-local core panel key for host-owned bootstrap resolution.
 *
 * The AdminTab convention allows only simple path-safe panel ids and rejects empty strings.
 *
 * @param {string} panelId Candidate owner-local core panel id.
 * @returns {string} Normalized panel id, or an empty string when invalid.
 */
function normalizeCorePanelKey(panelId) {
	const normalized = typeof panelId === 'string' ? panelId.trim() : '';
	return /^[a-z0-9][a-z0-9-]*$/i.test(normalized) ? normalized : '';
}

/**
 * Builds the conventional `entry.js` URL for one core panel.
 *
 * The returned URL stays host-owned and is derived only from the core panel key.
 *
 * @param {string} panelId Owner-local core panel id.
 * @returns {string} Relative AdminTab entry URL.
 */
function buildCorePanelEntryUrl(panelId) {
	const normalized = normalizeCorePanelKey(panelId);
	if (!normalized) {
		throw new Error(`Invalid core panel '${panelId}'`);
	}
	return `tab/panels/${encodeURIComponent(normalized)}/entry.js`;
}

/**
 * Normalizes one entry-owned asset list.
 *
 * The entry contract admits only trimmed, non-empty string paths. The resulting list is frozen
 * so downstream callers cannot mutate the host-owned bootstrap definition.
 *
 * @param {any} assetList Candidate asset list from `entry.js`.
 * @returns {ReadonlyArray<string>} Frozen normalized asset list.
 */
function normalizeCorePanelAssetList(assetList) {
	return Object.freeze(
		(Array.isArray(assetList) ? assetList : []).map(item => String(item || '').trim()).filter(Boolean),
	);
}

/**
 * Validates and freezes one loaded core-panel entry definition.
 *
 * The host contract is strict: every entry must provide `panelInit(ctx)` and may optionally
 * provide `css` / `js` asset lists. No fallback/global bridge is accepted here.
 *
 * @param {string} panelId Owner-local core panel id.
 * @param {any} entry Candidate entry definition read from `document.currentScript`.
 * @returns {CorePanelEntry} Frozen entry contract.
 */
function normalizeCorePanelEntry(panelId, entry) {
	if (!entry || typeof entry !== 'object') {
		throw new Error(`Core panel '${panelId}' entry did not export a definition`);
	}
	if (typeof entry.panelInit !== 'function') {
		throw new Error(`Core panel '${panelId}' entry is missing panelInit(ctx)`);
	}
	return Object.freeze({
		css: normalizeCorePanelAssetList(entry.css),
		js: normalizeCorePanelAssetList(entry.js),
		panelInit: entry.panelInit,
	});
}

/**
 * Loads one conventional host-owned core-panel entry.
 *
 * `entry.js` must assign its definition to `document.currentScript.__msghubCorePanelEntry`.
 * The promise is cached immediately so concurrent callers share one load path.
 *
 * @param {string} panelId Owner-local core panel id.
 * @returns {Promise<CorePanelEntry>}
 *   Promise for the validated frozen entry contract.
 */
function loadCorePanelEntry(panelId) {
	const normalized = normalizeCorePanelKey(panelId);
	if (!normalized) {
		return Promise.reject(new Error(`Invalid core panel '${panelId}'`));
	}
	const cached = corePanelEntryPromises.get(normalized);
	if (cached) {
		return cached;
	}

	const promise = new Promise((resolve, reject) => {
		const head = document.head || document.getElementsByTagName('head')[0];
		if (!head) {
			reject(new Error(`Core panel '${normalized}' entry cannot load without document.head`));
			return;
		}

		const script = document.createElement('script');
		script.src = buildCorePanelEntryUrl(normalized);
		script.async = false;
		script.defer = false;
		script.onload = () => {
			try {
				resolve(normalizeCorePanelEntry(normalized, script.__msghubCorePanelEntry));
			} catch (error) {
				corePanelEntryPromises.delete(normalized);
				reject(error);
			}
		};
		script.onerror = () => {
			corePanelEntryPromises.delete(normalized);
			reject(new Error(`Failed to load core panel entry: ${script.src}`));
		};
		head.appendChild(script);
	});

	corePanelEntryPromises.set(normalized, promise);
	return promise;
}

void loadCorePanelEntry;
void window;
