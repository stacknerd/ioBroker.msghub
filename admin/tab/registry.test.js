/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs/promises');
const path = require('node:path');
const { readRepoFile, repoRoot } = require('./_test.utils');

describe('admin/tab/registry.js', function () {
	it('builds a consistent, frozen registry', async function () {
		const source = await readRepoFile('admin/tab/registry.js');
		const sandbox = {
			window: {},
		};
		sandbox.win = sandbox.window;

		vm.runInNewContext(source, sandbox, { filename: 'admin/tab/registry.js' });
		const registry = sandbox.window.MsghubAdminTabRegistry;

		assert.ok(registry && typeof registry === 'object');
		assert.ok(Object.isFrozen(registry));
		assert.ok(Object.isFrozen(registry.panels));
		assert.ok(Object.isFrozen(registry.compositions));

		const panelIds = Object.keys(registry.panels);
		assert.ok(panelIds.length >= 2, 'expected at least messages/plugins panels');
		assert.equal(panelIds.includes('stats'), false, 'stats panel should be removed for now');

		for (const panelId of panelIds) {
			const panel = registry.panels[panelId];
			// id must be the canonical tab-id form, not the short registry key.
			assert.equal(panel.id, `tab-${panelId}`);
			assert.ok(typeof panel.label === 'string' && panel.label.trim());
			assert.ok(panel.ui && typeof panel.ui === 'object');
			assert.equal(panel.ui.kind, 'core');
			assert.equal(panel.ui.loader, 'globals');
			assert.ok(typeof panel.ui.initGlobal === 'string' && panel.ui.initGlobal.trim());
			assert.ok(Array.isArray(panel.ui.css));
			assert.ok(Array.isArray(panel.ui.js));
			assert.ok(Object.isFrozen(panel));
			assert.ok(Object.isFrozen(panel.ui));
			assert.ok(Object.isFrozen(panel.ui.css));
			assert.ok(Object.isFrozen(panel.ui.js));
			// Old fields must be absent.
			assert.equal(panel.mountId, undefined);
			assert.equal(panel.titleKey, undefined);
			assert.equal(panel.assets, undefined);
			assert.equal(panel.initGlobal, undefined);

			// If panel carries an optional app block, validate its required and optional fields.
			if (panel.app !== undefined) {
				assert.ok(panel.app && typeof panel.app === 'object', `panel '${panelId}': app must be an object`);
				assert.ok(
					typeof panel.app.name === 'string' && panel.app.name.trim(),
					`panel '${panelId}': app.name must be a non-empty string`,
				);
				assert.ok(
					typeof panel.app.url === 'string' && panel.app.url.trim(),
					`panel '${panelId}': app.url must be a non-empty string`,
				);
				if (panel.app.shortName !== undefined) {
					assert.ok(
						typeof panel.app.shortName === 'string' && panel.app.shortName.trim(),
						`panel '${panelId}': app.shortName must be a non-empty string when present`,
					);
				}
				if (panel.app.themeColor !== undefined) {
					assert.ok(
						typeof panel.app.themeColor === 'string',
						`panel '${panelId}': app.themeColor must be a string when present`,
					);
				}
				if (panel.app.icons !== undefined) {
					assert.ok(Array.isArray(panel.app.icons), `panel '${panelId}': app.icons must be an array when present`);
					for (const icon of panel.app.icons) {
						assert.ok(
							icon && typeof icon === 'object' && typeof icon.src === 'string' && icon.src.trim(),
							`panel '${panelId}': each app.icons entry must have a non-empty src string`,
						);
					}
				}
			}

			for (const asset of [...panel.ui.css, ...panel.ui.js]) {
				const fullPath = path.join(repoRoot, 'admin', String(asset));
				try {
					await fs.access(fullPath);
				} catch {
					assert.fail(`missing panel asset: ${asset}`);
				}
			}
		}

		for (const [compositionId, composition] of Object.entries(registry.compositions)) {
			assert.equal(composition.id, compositionId);
			assert.ok(composition.layout === 'tabs' || composition.layout === 'single');
			assert.ok(Array.isArray(composition.panels) && composition.panels.length > 0);
			assert.ok(typeof composition.defaultPanel === 'string' && composition.defaultPanel.trim());

			// defaultPanel is a plain string — either a native panel ID or a plugin panel DOM key.
			const defaultResolvable =
				composition.panels.some(p => typeof p === 'string' && p === composition.defaultPanel) ||
				composition.panels.some(p => typeof p === 'string' && p === '*') ||
				String(composition.defaultPanel).startsWith('plugin-');
			assert.ok(defaultResolvable, `defaultPanel '${composition.defaultPanel}' not resolvable in '${compositionId}'`);

			for (const panelEntry of composition.panels) {
				if (typeof panelEntry === 'string') {
					if (panelEntry === '*') {
						continue;
					}
					assert.ok(registry.panels[panelEntry], `unknown native panel '${panelEntry}' in composition '${compositionId}'`);
				} else if (panelEntry && typeof panelEntry === 'object') {
					// Structured plugin panel reference — must have required shape fields.
					assert.equal(panelEntry.type, 'pluginPanel', `non-string panel entry must be a pluginPanel ref`);
					assert.ok(typeof panelEntry.pluginType === 'string' && panelEntry.pluginType, 'pluginPanel ref requires pluginType');
					assert.ok(typeof panelEntry.panelId === 'string' && panelEntry.panelId, 'pluginPanel ref requires panelId');
				}
			}
		}
		assert.equal(registry.compositions.dashboardStats, undefined, 'legacy stats composition should be removed');
	});

	it('adminTab composition includes a structured pluginPanel ref; registry.panels stays native-only', async function () {
		const source = await readRepoFile('admin/tab/registry.js');
		const sandbox = { window: {} };
		sandbox.win = sandbox.window;
		vm.runInNewContext(source, sandbox, { filename: 'admin/tab/registry.js' });
		const registry = sandbox.window.MsghubAdminTabRegistry;

		const adminTab = registry.compositions.adminTab;
		assert.ok(Array.isArray(adminTab.panels), 'adminTab.panels must be an array');

		// Locate the structured plugin panel ref entry.
		const pluginEntry = adminTab.panels.find(p => p && typeof p === 'object' && p.type === 'pluginPanel');
		assert.ok(pluginEntry, 'adminTab composition must contain at least one structured pluginPanel ref');
		assert.equal(pluginEntry.pluginType, 'IngestStates');
		assert.equal(pluginEntry.instanceId, 0);
		assert.equal(pluginEntry.panelId, 'presets');
		assert.ok(Object.isFrozen(pluginEntry), 'pluginPanel ref must be frozen');

		// registry.panels must not contain any plugin panel entries.
		for (const [id, panel] of Object.entries(registry.panels)) {
			assert.ok(typeof id === 'string' && panel.ui?.kind === 'core', `registry.panels entry '${id}' must be a native core panel definition`);
		}
	});

	it('exposes a dedicated single-layout composition for messages', async function () {
		const source = await readRepoFile('admin/tab/registry.js');
		const sandbox = { window: {} };
		sandbox.win = sandbox.window;
		vm.runInNewContext(source, sandbox, { filename: 'admin/tab/registry.js' });
		const registry = sandbox.window.MsghubAdminTabRegistry;

		const composition = registry.compositions.messagesSingle;
		assert.ok(composition, 'messagesSingle composition must exist');
		assert.equal(composition.layout, 'single');
		assert.deepEqual(JSON.parse(JSON.stringify(composition.panels)), ['messages']);
		assert.equal(composition.defaultPanel, 'messages');
	});

	describe('app block schema validator', function () {
		/**
		 * Applies the same validation rules as the panel loop above.
		 * Throws with a descriptive message when the app block violates schema constraints.
		 */
		function validateAppBlock(panel) {
			if (panel.app === undefined) {
				return; // absent is valid
			}
			if (!panel.app || typeof panel.app !== 'object') {
				throw new Error('app must be an object');
			}
			if (typeof panel.app.name !== 'string' || !panel.app.name.trim()) {
				throw new Error('app.name is required and must be a non-empty string');
			}
			if (typeof panel.app.url !== 'string' || !panel.app.url.trim()) {
				throw new Error('app.url is required and must be a non-empty string');
			}
			if (panel.app.shortName !== undefined) {
				if (typeof panel.app.shortName !== 'string' || !panel.app.shortName.trim()) {
					throw new Error('app.shortName must be a non-empty string when present');
				}
			}
			if (panel.app.themeColor !== undefined) {
				if (typeof panel.app.themeColor !== 'string') {
					throw new Error('app.themeColor must be a string when present');
				}
			}
			if (panel.app.icons !== undefined) {
				if (!Array.isArray(panel.app.icons)) {
					throw new Error('app.icons must be an array when present');
				}
				for (const icon of panel.app.icons) {
					if (!icon || typeof icon !== 'object' || typeof icon.src !== 'string' || !icon.src.trim()) {
						throw new Error('each app.icons entry must have a non-empty src string');
					}
				}
			}
		}

		const basePanel = {
			id: 'tab-test',
			label: 'msghub.i18n.some.label',
			ui: { kind: 'core', loader: 'globals', initGlobal: 'MsghubAdminTabTest', css: [], js: [] },
		};

		it('panel without app block passes silently', function () {
			assert.doesNotThrow(() => validateAppBlock({ ...basePanel }));
		});

		it('panel with a valid app block (name + url) passes', function () {
			const panel = { ...basePanel, app: { name: 'msghub.i18n.some.label', url: 'https://example.com' } };
			assert.doesNotThrow(() => validateAppBlock(panel));
		});

		it('app block without name is rejected', function () {
			const panel = { ...basePanel, app: { url: 'https://example.com' } };
			assert.throws(() => validateAppBlock(panel), /name/);
		});

		it('app block without url is rejected', function () {
			const panel = { ...basePanel, app: { name: 'msghub.i18n.some.label' } };
			assert.throws(() => validateAppBlock(panel), /url/);
		});

		it('app block without shortName passes (shortName is optional)', function () {
			// Valid app block with name and url only; absence of shortName must not throw.
			const panel = { ...basePanel, app: { name: 'msghub.i18n.some.label', url: 'https://example.com' } };
			assert.doesNotThrow(() => validateAppBlock(panel));
		});

		it('app block with all optional fields present and valid passes', function () {
			const panel = {
				...basePanel,
				app: {
					name: 'msghub.i18n.some.label',
					url: 'https://example.com',
					shortName: 'msghub.i18n.some.short',
					themeColor: '#1f6a53',
					icons: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
				},
			};
			assert.doesNotThrow(() => validateAppBlock(panel));
		});

		it('app.shortName present but empty is rejected', function () {
			const panel = { ...basePanel, app: { name: 'msghub.i18n.some.label', url: 'https://example.com', shortName: '  ' } };
			assert.throws(() => validateAppBlock(panel), /shortName/);
		});

		it('app.themeColor present but non-string is rejected', function () {
			const panel = { ...basePanel, app: { name: 'msghub.i18n.some.label', url: 'https://example.com', themeColor: 42 } };
			assert.throws(() => validateAppBlock(panel), /themeColor/);
		});

		it('app.icons present but not an array is rejected', function () {
			const panel = { ...basePanel, app: { name: 'msghub.i18n.some.label', url: 'https://example.com', icons: 'bad' } };
			assert.throws(() => validateAppBlock(panel), /icons/);
		});

		it('app.icons element without src is rejected', function () {
			const panel = {
				...basePanel,
				app: { name: 'msghub.i18n.some.label', url: 'https://example.com', icons: [{ sizes: '192x192' }] },
			};
			assert.throws(() => validateAppBlock(panel), /src/);
		});
	});

	it('is idempotent when loaded multiple times', async function () {
		const source = await readRepoFile('admin/tab/registry.js');
		const original = Object.freeze({ keep: true });
		const sandbox = {
			window: {
				MsghubAdminTabRegistry: original,
			},
		};
		sandbox.win = sandbox.window;

		vm.runInNewContext(source, sandbox, { filename: 'admin/tab/registry.js' });

		assert.equal(sandbox.window.MsghubAdminTabRegistry, original);
	});
});
