'use strict';

const { expect } = require('chai');

const { MsgConfig } = require('./MsgConfig');

describe('MsgConfig', () => {
	describe('quietHours normalization', () => {
		it('valid quiet hours produce normalized config', () => {
			const res = MsgConfig.normalize({
				adapterConfig: {
					notifierIntervalSec: 10,
					quietHoursEnabled: true,
					quietHoursStart: '22:00',
					quietHoursEnd: '06:00',
					quietHoursMaxLevel: 20,
					quietHoursSpreadMin: 0,
				},
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
			expect(res.corePrivate).to.have.property('render');
			expect(res.pluginPublic).to.have.property('render');
		});

		it('disabled when notifierIntervalMs <= 0', () => {
			const res = MsgConfig.normalize({
				adapterConfig: {
					notifierIntervalSec: 0,
					quietHoursEnabled: true,
					quietHoursStart: '22:00',
					quietHoursEnd: '06:00',
					quietHoursMaxLevel: 20,
					quietHoursSpreadMin: 0,
				},
			});

			expect(res.corePrivate.quietHours).to.equal(null);
			expect(res.pluginPublic.quietHours).to.equal(null);
			expect(res.errors).to.include('quietHours.disabled.notifierIntervalMs');
		});

		it('disabled when start == end', () => {
			const res = MsgConfig.normalize({
				adapterConfig: {
					notifierIntervalSec: 10,
					quietHoursEnabled: true,
					quietHoursStart: '22:00',
					quietHoursEnd: '22:00',
					quietHoursMaxLevel: 20,
					quietHoursSpreadMin: 0,
				},
			});

			expect(res.corePrivate.quietHours).to.equal(null);
			expect(res.errors).to.include('quietHours.disabled.startEqualsEnd');
		});

		it('disabled when start/end invalid', () => {
			const res = MsgConfig.normalize({
				adapterConfig: {
					notifierIntervalSec: 10,
					quietHoursEnabled: true,
					quietHoursStart: '25:00',
					quietHoursEnd: '06:00',
					quietHoursMaxLevel: 20,
					quietHoursSpreadMin: 0,
				},
			});

			expect(res.corePrivate.quietHours).to.equal(null);
			expect(res.errors).to.include('quietHours.disabled.invalidTime.quietHoursStart');
		});

		it('disabled when maxLevel/spread invalid', () => {
			const res = MsgConfig.normalize({
				adapterConfig: {
					notifierIntervalSec: 10,
					quietHoursEnabled: true,
					quietHoursStart: '22:00',
					quietHoursEnd: '06:00',
					quietHoursMaxLevel: 'nope',
					quietHoursSpreadMin: 0,
				},
			});

			expect(res.corePrivate.quietHours).to.equal(null);
			expect(res.errors).to.include('quietHours.disabled.invalidMaxLevelOrSpreadMin');
		});

		it('disabled when freeMin < 240', () => {
			const res = MsgConfig.normalize({
				adapterConfig: {
					notifierIntervalSec: 10,
					quietHoursEnabled: true,
					quietHoursStart: '00:00',
					quietHoursEnd: '20:30',
					quietHoursMaxLevel: 20,
					quietHoursSpreadMin: 0,
				},
			});

			expect(res.corePrivate.quietHours).to.equal(null);
			expect(res.errors).to.include('quietHours.disabled.tooLittleFreeTime');
		});

		it('disabled when spreadMin > freeMin', () => {
			const res = MsgConfig.normalize({
				adapterConfig: {
					notifierIntervalSec: 10,
					quietHoursEnabled: true,
					quietHoursStart: '22:00',
					quietHoursEnd: '06:00',
					quietHoursMaxLevel: 20,
					quietHoursSpreadMin: 1000,
				},
			});

			expect(res.corePrivate.quietHours).to.equal(null);
			expect(res.errors).to.include('quietHours.disabled.spreadDoesNotFit');
		});
	});

	describe('render normalization', () => {
		it('normalizes prefixes and templates with expected defaults', () => {
			const res = MsgConfig.normalize({
				adapterConfig: {
					quietHoursEnabled: false,
					prefixLevelWarning: ' ⚠️ ',
					prefixKindTask: '✅',
					renderTitleTemplate: ' {{icon}} {{title}} ',
					renderTextTemplate: '',
					renderIconTemplate: null,
				},
			});

			expect(res.errors).to.deep.equal([]);

			expect(res.corePrivate.render).to.have.nested.property('prefixes.level.warning', '⚠️');
			expect(res.corePrivate.render).to.have.nested.property('prefixes.kind.task', '✅');

			expect(res.corePrivate.render).to.have.nested.property('templates.titleTemplate', '{{icon}} {{title}}');
			// empty/invalid => defaults
			expect(res.corePrivate.render).to.have.nested.property('templates.textTemplate', '{{levelPrefix}} {{text}}');
			expect(res.corePrivate.render).to.have.nested.property('templates.iconTemplate', '{{icon}}');

			expect(Object.isFrozen(res.corePrivate.render)).to.equal(true);
			expect(Object.isFrozen(res.corePrivate.render.prefixes)).to.equal(true);
			expect(Object.isFrozen(res.corePrivate.render.templates)).to.equal(true);

			expect(res.pluginPublic.render).to.be.an('object');
			expect(res.pluginPublic.render.prefixes).to.equal(res.corePrivate.render.prefixes);
			expect(res.pluginPublic.render.templates).to.equal(res.corePrivate.render.templates);
		});
	});

	describe('ai normalization', () => {
		it('does not expose secrets via pluginPublic', () => {
			const res = MsgConfig.normalize({
				adapterConfig: {
					aiEnabled: true,
					aiProvider: 'openai',
					aiOpenAiApiKey: 'should-not-leak',
					aiOpenAiBaseUrl: 'https://internal.example/v1',
				},
				decrypted: { aiOpenAiApiKey: 'sk-test-1234567890' },
			});

			expect(res.corePrivate).to.have.nested.property('ai.openai.apiKey', 'sk-test-1234567890');
			expect(res.pluginPublic).to.have.property('ai');
			expect(res.pluginPublic.ai).to.have.property('openai');
			expect(res.pluginPublic.ai.openai).to.not.have.property('apiKey');
			expect(res.pluginPublic.ai.openai).to.not.have.property('baseUrl');
		});
	});

	describe('archive normalization', () => {
		it('normalizes strategy lock metadata', () => {
			const res = MsgConfig.normalize({
				adapterConfig: {
					quietHoursEnabled: false,
					archiveEffectiveStrategyLock: ' NATIVE ',
					archiveLockReason: 'manual-upgrade',
					archiveLockedAt: '1700000000000',
				},
			});

			expect(res.errors).to.deep.equal([]);
			expect(res.corePrivate.archive).to.deep.include({
				effectiveStrategyLock: 'native',
				lockReason: 'manual-upgrade',
				lockedAt: 1700000000000,
			});
		});

		it('drops invalid strategy lock and reports normalization error', () => {
			const res = MsgConfig.normalize({
				adapterConfig: {
					quietHoursEnabled: false,
					archiveEffectiveStrategyLock: 'maybe',
				},
			});

			expect(res.corePrivate.archive.effectiveStrategyLock).to.equal('');
			expect(res.errors).to.include('archive.strategy.invalidLock');
		});
	});
});
