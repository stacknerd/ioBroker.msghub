/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { createH, loadPanelModule } = require('./_test.utils');

async function loadBulkApplyModule(extras = {}) {
	return loadPanelModule('admin/tab/panels/plugins/overlay.bulkapply.js', extras);
}

function findElement(root, predicate) {
	if (!root || typeof root !== 'object') {
		return null;
	}
	if (predicate(root)) {
		return root;
	}
	for (const child of Array.isArray(root.children) ? root.children : []) {
		const found = findElement(child, predicate);
		if (found) {
			return found;
		}
	}
	return null;
}

describe('admin/tab/panels/plugins/overlay.bulkapply.js', function () {
	it('seeds preview/apply payloads from ingest constants without schema metadata', async function () {
		const sandbox = await loadBulkApplyModule();
		const { createPluginsBulkApplyApi } = sandbox.window.MsghubAdminTabPluginsBulkApply;
		let previewPayload = null;

		const api = createPluginsBulkApplyApi({
			h: createH(),
			ingestStatesDataApi: {
				bulkApplyPreview: async params => {
					previewPayload = params;
					return {
						pattern: params.pattern,
						matchedStates: 1,
						willChange: 1,
						unchanged: 0,
						sample: [{ id: 'dev.0.sensor', changed: true }],
					};
				},
			},
		});

		const root = api.renderIngestStatesBulkApply({
			instances: [{ instanceId: 0, enabled: true }],
			ingestConstants: {
				jsonCustomDefaults: {
					mode: '',
					'thr-mode': 'lt',
					'thr-value': 10,
				},
			},
		});

		const inputs = [];
		findElement(root, el => {
			if (el?.tagName === 'INPUT') {
				inputs.push(el);
			}
			return false;
		});
		const patternInput = inputs[1] || null;
		const previewButton = findElement(root, el => el?.tagName === 'BUTTON' && el.textContent === 'Generate preview');
		const customArea = findElement(
			root,
			el => el?.tagName === 'TEXTAREA' && String(el.value || '').includes('"thr-mode"'),
		);

		assert.ok(patternInput, 'pattern input not found');
		assert.ok(previewButton, 'preview button not found');
		assert.ok(customArea, 'custom JSON textarea not found');

		const seeded = JSON.parse(customArea.value);
		assert.equal(seeded.enabled, true);
		assert.equal(seeded.mode, '');
		assert.equal(seeded['thr-mode'], 'lt');
		assert.equal(seeded['thr-value'], 10);

		patternInput.value = 'dev.0.*';
		previewButton.dispatchEvent({ type: 'click', preventDefault() {} });
		await Promise.resolve();

		assert.ok(previewPayload, 'bulkApplyPreview was not called');
		assert.equal(previewPayload.pattern, 'dev.0.*');
		assert.equal(previewPayload.custom.enabled, true);
		assert.equal(previewPayload.custom['thr-mode'], 'lt');
		assert.equal(previewPayload.custom['thr-value'], 10);
	});
});
