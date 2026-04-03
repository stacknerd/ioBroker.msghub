'use strict';

const { expect } = require('chai');

const {
	MAP_TYPE_MARKER,
	normalizeCreateLikePayload,
	normalizePatchLikePayload,
	toJsonSafe,
} = require('./transport');

describe('EngageSendTo transport', () => {
	it('normalizes plain-object metrics into a Map for create-like payloads', () => {
		const payload = normalizeCreateLikePayload({
			ref: 'x',
			metrics: {
				battTime: { val: 12, unit: 's', ts: Date.UTC(2026, 0, 1) },
			},
		});

		expect(payload.metrics).to.be.instanceOf(Map);
		expect(payload.metrics.get('battTime')).to.deep.equal({
			val: 12,
			unit: 's',
			ts: Date.UTC(2026, 0, 1),
		});
	});

	it('revives encoded maps in patch-like payloads', () => {
		const payload = normalizePatchLikePayload({
			ref: 'x',
			patch: {
				metrics: {
					[MAP_TYPE_MARKER]: 'Map',
					value: [['remainingTime', { val: 17, unit: 'min', ts: Date.UTC(2026, 0, 2) }]],
				},
			},
		});

		expect(payload.patch.metrics).to.be.instanceOf(Map);
		expect(payload.patch.metrics.get('remainingTime')).to.deep.equal({
			val: 17,
			unit: 'min',
			ts: Date.UTC(2026, 0, 2),
		});
	});

	it('serializes Maps into the documented JSON-safe marker format', () => {
		const out = toJsonSafe({
			metrics: new Map([['battTime', { val: 12, unit: 's', ts: Date.UTC(2026, 0, 1) }]]),
		});

		expect(out).to.deep.equal({
			metrics: {
				[MAP_TYPE_MARKER]: 'Map',
				value: [['battTime', { val: 12, unit: 's', ts: Date.UTC(2026, 0, 1) }]],
			},
		});
	});
});
