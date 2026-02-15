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
		assert.ok(panelIds.length >= 3, 'expected at least stats/messages/plugins panels');

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
			assert.ok(composition.panels.includes(composition.defaultPanel));

			for (const panelId of composition.panels) {
				assert.ok(registry.panels[panelId], `unknown panel '${panelId}' in composition '${compositionId}'`);
			}
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
