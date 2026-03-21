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
			assert.equal(panel.id, panelId);
			assert.ok(typeof panel.mountId === 'string' && panel.mountId.trim());
			assert.ok(typeof panel.titleKey === 'string' && panel.titleKey.trim());
			assert.ok(typeof panel.initGlobal === 'string' && panel.initGlobal.trim());
			assert.ok(panel.assets && typeof panel.assets === 'object');
			assert.ok(Array.isArray(panel.assets.css));
			assert.ok(Array.isArray(panel.assets.js));
			assert.ok(Object.isFrozen(panel));
			assert.ok(Object.isFrozen(panel.assets));
			assert.ok(Object.isFrozen(panel.assets.css));
			assert.ok(Object.isFrozen(panel.assets.js));

			for (const asset of [...panel.assets.css, ...panel.assets.js]) {
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
				String(composition.defaultPanel).startsWith('plugin-');
			assert.ok(defaultResolvable, `defaultPanel '${composition.defaultPanel}' not resolvable in '${compositionId}'`);

			for (const panelEntry of composition.panels) {
				if (typeof panelEntry === 'string') {
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
			assert.ok(typeof id === 'string' && panel.mountId, `registry.panels entry '${id}' must be a native panel definition`);
		}
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
