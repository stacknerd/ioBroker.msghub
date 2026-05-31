'use strict';

const { expect } = require('chai');

const { manifest } = require('./manifest');

describe('IngestHue manifest', () => {
	it('declares a discoverable multi-instance ingest plugin with safe defaults', () => {
		expect(manifest).to.include({
			schemaVersion: 1,
			type: 'IngestHue',
			defaultEnabled: false,
			supportsMultiple: true,
			supportsChannelRouting: false,
		});
		expect(manifest.discoverable).to.equal(undefined);
	});

	it('defines the expected configuration schema', () => {
		expect(manifest.options.hueInstance.default).to.equal('hue.0');
		expect(manifest.options.monitorBattery).to.include({ type: 'boolean', default: true });
		expect(manifest.options.monitorReachable).to.include({ type: 'boolean', default: true });
		expect(manifest.options.batteryCreateBelow).to.include({ type: 'number', default: 7, min: 0, max: 100 });
		expect(manifest.options.batteryRemoveAbove).to.include({ type: 'number', default: 30, min: 0, max: 100 });
		expect(manifest.options.reachableAllowRolesCsv.default).to.equal('ZLLSwitch, ZLLPresence');
		expect(manifest.options.rescanIntervalMs).to.include({
			type: 'number',
			default: 60 * 60 * 1000,
			min: 0,
		});
		expect(manifest.options.audienceTagsCsv).to.include({ type: 'string', default: '' });
		expect(manifest.options.audienceChannelsIncludeCsv).to.include({ type: 'string', default: '' });
		expect(manifest.options.audienceChannelsExcludeCsv).to.include({ type: 'string', default: '' });
	});
});
