'use strict';

const { expect } = require('chai');

const { MsgConfig } = require('./MsgConfig');

describe('MsgConfig', () => {
	describe('quietHours normalization', () => {
		it('valid quiet hours produce normalized config', () => {
			const res = MsgConfig.normalize({
				adapterConfig: {
					quietHoursEnabled: true,
					quietHoursStart: '22:00',
					quietHoursEnd: '06:00',
					quietHoursMaxLevel: 20,
					quietHoursSpreadMin: 0,
				},
				notifierIntervalMs: 10_000,
			});

			expect(res.errors).to.deep.equal([]);
			expect(res.corePrivate.quietHours).to.deep.equal({
				enabled: true,
				startMin: 22 * 60,
				endMin: 6 * 60,
				maxLevel: 20,
				spreadMs: 0,
			});

			expect(res.pluginPublic.quietHours).to.deep.equal(res.corePrivate.quietHours);
			expect(res.pluginPublic.quietHours).to.not.equal(res.corePrivate.quietHours);

			expect(Object.isFrozen(res.corePrivate)).to.equal(true);
			expect(Object.isFrozen(res.pluginPublic)).to.equal(true);
			expect(Object.isFrozen(res.corePrivate.quietHours)).to.equal(true);
			expect(Object.isFrozen(res.pluginPublic.quietHours)).to.equal(true);
		});

		it('disabled when notifierIntervalMs <= 0', () => {
			const res = MsgConfig.normalize({
				adapterConfig: {
					quietHoursEnabled: true,
					quietHoursStart: '22:00',
					quietHoursEnd: '06:00',
					quietHoursMaxLevel: 20,
					quietHoursSpreadMin: 0,
				},
				notifierIntervalMs: 0,
			});

			expect(res.corePrivate.quietHours).to.equal(null);
			expect(res.pluginPublic.quietHours).to.equal(null);
			expect(res.errors).to.include('quietHours.disabled.notifierIntervalMs');
		});

		it('disabled when start == end', () => {
			const res = MsgConfig.normalize({
				adapterConfig: {
					quietHoursEnabled: true,
					quietHoursStart: '22:00',
					quietHoursEnd: '22:00',
					quietHoursMaxLevel: 20,
					quietHoursSpreadMin: 0,
				},
				notifierIntervalMs: 10_000,
			});

			expect(res.corePrivate.quietHours).to.equal(null);
			expect(res.errors).to.include('quietHours.disabled.startEqualsEnd');
		});

		it('disabled when start/end invalid', () => {
			const res = MsgConfig.normalize({
				adapterConfig: {
					quietHoursEnabled: true,
					quietHoursStart: '25:00',
					quietHoursEnd: '06:00',
					quietHoursMaxLevel: 20,
					quietHoursSpreadMin: 0,
				},
				notifierIntervalMs: 10_000,
			});

			expect(res.corePrivate.quietHours).to.equal(null);
			expect(res.errors).to.include('quietHours.disabled.invalidTime.quietHoursStart');
		});

		it('disabled when maxLevel/spread invalid', () => {
			const res = MsgConfig.normalize({
				adapterConfig: {
					quietHoursEnabled: true,
					quietHoursStart: '22:00',
					quietHoursEnd: '06:00',
					quietHoursMaxLevel: 'nope',
					quietHoursSpreadMin: 0,
				},
				notifierIntervalMs: 10_000,
			});

			expect(res.corePrivate.quietHours).to.equal(null);
			expect(res.errors).to.include('quietHours.disabled.invalidMaxLevelOrSpreadMin');
		});

		it('disabled when freeMin < 240', () => {
			const res = MsgConfig.normalize({
				adapterConfig: {
					quietHoursEnabled: true,
					quietHoursStart: '00:00',
					quietHoursEnd: '20:30',
					quietHoursMaxLevel: 20,
					quietHoursSpreadMin: 0,
				},
				notifierIntervalMs: 10_000,
			});

			expect(res.corePrivate.quietHours).to.equal(null);
			expect(res.errors).to.include('quietHours.disabled.tooLittleFreeTime');
		});

		it('disabled when spreadMin > freeMin', () => {
			const res = MsgConfig.normalize({
				adapterConfig: {
					quietHoursEnabled: true,
					quietHoursStart: '22:00',
					quietHoursEnd: '06:00',
					quietHoursMaxLevel: 20,
					quietHoursSpreadMin: 1000,
				},
				notifierIntervalMs: 10_000,
			});

			expect(res.corePrivate.quietHours).to.equal(null);
			expect(res.errors).to.include('quietHours.disabled.spreadDoesNotFit');
		});
	});
});

