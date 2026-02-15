/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { loadPanelModule } = require('./_test.utils');

describe('admin/tab/panels/messages/data.messages.js', function () {
	function createFixture() {
		const state = {
			columnFilters: Object.create(null),
			items: [
				{
					kind: 'task',
					level: 2,
					origin: { system: 'sys.a' },
					details: { location: 'kitchen' },
					lifecycle: { state: 'open' },
				},
				{
					kind: 'alert',
					level: 3,
					origin: { system: 'sys.b' },
					details: { location: 'office' },
					lifecycle: { state: 'closed' },
				},
			],
			constants: {
				level: { LOW: 1, MEDIUM: 2, HIGH: 3 },
				kind: { TASK: 'task', ALERT: 'alert' },
				lifecycle: { state: { open: 'open', closed: 'closed', snoozed: 'snoozed', acked: 'acked' } },
			},
			pageIndex: 2,
			pageSize: 25,
			sortField: 'timing.createdAt',
			sortDir: 'desc',
		};
		const calls = { query: [], delete: [], constants: 0 };
		const api = {
			i18n: { tOr: (key, fallback) => `${key}|${fallback}` },
			messages: {
				query: async payload => {
					calls.query.push(payload);
					return { items: [], total: 0, pages: 1 };
				},
				delete: async refs => {
					calls.delete.push(refs);
				},
			},
			constants: {
				get: async () => {
					calls.constants += 1;
					return state.constants;
				},
			},
		};
		const pick = (obj, path) => path.split('.').reduce((cur, key) => (cur ? cur[key] : undefined), obj);
		return { state, api, calls, pick };
	}

	it('builds where payload from filters including enum conversion', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/data.messages.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesDataMessages;
		const { state, api, pick } = createFixture();
		const dataApi = moduleApi.createMessagesDataApi({
			api,
			state,
			pick,
			safeStr: value => (value == null ? '' : String(value)),
			isObject: value => !!value && typeof value === 'object' && !Array.isArray(value),
		});

		await dataApi.loadConstants();
		const VmSet = dataApi.getFilterSet('lifecycle.state').constructor;
		const vmSet = values => new VmSet(values);
		dataApi.setFilterSet('kind', vmSet(['task']));
		dataApi.setFilterSet('level', vmSet(['HIGH']));
		dataApi.setFilterSet('origin.system', vmSet(['sys.a']));
		dataApi.setFilterSet('details.location', vmSet(['kitchen']));
		dataApi.setFilterSet('lifecycle.state', vmSet(['open']));

		const where = dataApi.buildWhereFromFilters();
		assert.deepEqual(JSON.parse(JSON.stringify(where)), {
			kind: { in: ['task'] },
			level: { in: [3] },
			origin: { system: { in: ['sys.a'] } },
			details: { location: { in: ['kitchen'] } },
			lifecycle: { state: { in: ['open'] } },
		});
	});

	it('canonicalizes lifecycle defaults from constants and queries/deletes through api', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/data.messages.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesDataMessages;
		const { state, api, calls, pick } = createFixture();
		const dataApi = moduleApi.createMessagesDataApi({
			api,
			state,
			pick,
			safeStr: value => (value == null ? '' : String(value)),
			isObject: value => !!value && typeof value === 'object' && !Array.isArray(value),
		});

		await dataApi.loadConstants();
		assert.equal(calls.constants, 1);
		assert.deepEqual(Array.from(dataApi.getFilterSet('lifecycle.state')), ['acked', 'closed', 'open', 'snoozed']);

		await dataApi.queryMessagesPage();
		assert.equal(calls.query.length, 1);
		assert.equal(calls.query[0].query.page.index, 2);
		assert.equal(calls.query[0].query.page.size, 25);
		assert.deepEqual(JSON.parse(JSON.stringify(calls.query[0].query.sort)), [{ field: 'timing.createdAt', dir: 'desc' }]);

		await dataApi.deleteMessages(['r1', 'r2']);
		assert.deepEqual(calls.delete[0], ['r1', 'r2']);
	});

	it('resolves labels and enum helpers for edge cases', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/data.messages.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesDataMessages;
		const { state, api, pick } = createFixture();
		const dataApi = moduleApi.createMessagesDataApi({
			api,
			state,
			pick,
			safeStr: value => (value == null ? '' : String(value)),
			isObject: value => !!value && typeof value === 'object' && !Array.isArray(value),
		});

		assert.equal(dataApi.getLevelLabel(3), 'HIGH');
		assert.equal(dataApi.getLevelNumber('MEDIUM'), 2);
		assert.equal(dataApi.getLevelNumber('42'), 42);
		assert.deepEqual(Array.from(dataApi.listDistinctFromItems('details.location')), ['kitchen', 'office']);
		assert.equal(
			dataApi.renderFilterValueLabel('kind', 'task'),
			'msghub.i18n.core.admin.common.MsgConstants.kind.task.label|task',
		);
		assert.equal(dataApi.renderFilterValueLabel('unknown', 'x'), 'x');
	});
});
