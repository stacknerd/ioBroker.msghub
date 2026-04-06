'use strict';

const { expect } = require('chai');

const { IoWebUi } = require('./IoWebUi');

describe('IoWebUi handleCommand', () => {
	function createAdapter() {
		return {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
	}

	it('web.ping returns pong', async () => {
		const webUi = new IoWebUi(createAdapter());
		const res = await webUi.handleCommand('web.ping', null);
		expect(res.ok).to.equal(true);
		expect(res.data).to.equal('pong');
	});

	it('web.stats.get normalizes include payload and returns store stats', async () => {
		const calls = [];
		const webUi = new IoWebUi(createAdapter(), {
			msgStore: {
				getStats: async include => {
					calls.push(include);
					return { count: 3 };
				},
			},
		});
		const res = await webUi.handleCommand('web.stats.get', {
			include: { archiveSize: true, archiveSizeMaxAgeMs: -4 },
		});
		expect(calls).to.deep.equal([{ include: { archiveSize: true, archiveSizeMaxAgeMs: 0 } }]);
		expect(res).to.deep.equal({ ok: true, data: { count: 3 } });
	});

	it('web.constants.get returns selected constant groups only', async () => {
		const webUi = new IoWebUi(createAdapter(), {
			msgStore: {
				msgConstants: {
					kind: { info: 'info' },
					lifecycle: { state: { active: 'active' }, ignored: true },
					level: { high: 'high' },
					notfication: { events: { ack: 'ack' }, ignored: true },
				},
			},
		});
		const res = await webUi.handleCommand('web.constants.get', {});
		expect(res).to.deep.equal({
			ok: true,
			data: {
				kind: { info: 'info' },
				lifecycle: { state: { active: 'active' } },
				level: { high: 'high' },
				notfication: { events: { ack: 'ack' } },
			},
		});
	});

	it('web.messages.query returns normalized query result', async () => {
		const webUi = new IoWebUi(createAdapter(), {
			msgStore: {
				queryMessages: query => ({
					items: [{ ref: 'r1', meta: new Map([['k', 'v']]) }],
					total: 1,
					pages: 1,
					query,
				}),
			},
		});
		const res = await webUi.handleCommand('web.messages.query', {
			query: {
				where: { kind: 'alert' },
				page: { size: 10 },
				sort: [{ field: 'ts', dir: 'desc' }],
				extra: true,
			},
		});
		expect(res.ok).to.equal(true);
		expect(res.data.items).to.deep.equal([{ ref: 'r1', meta: { __msghubType: 'Map', value: [['k', 'v']] } }]);
		expect(res.data.total).to.equal(1);
		expect(res.data.pages).to.equal(1);
		expect(res.data.meta).to.have.property('generatedAt');
		expect(res.data.meta).to.have.property('tz');
	});

	it('web.messages.action executes via msgActions', async () => {
		const actors = [];
		const webUi = new IoWebUi(createAdapter(), {
			msgStore: {
				msgActions: {
					execute(opts) {
						actors.push(opts.actor);
						return true;
					},
				},
			},
		});
		const res = await webUi.handleCommand('web.messages.action', { ref: 'r1', actionId: 'ack' });
		expect(actors).to.deep.equal(['WebUi']);
		expect(res).to.deep.equal({ ok: true, data: { executed: true } });
	});

	it('rejects unknown web commands', async () => {
		const webUi = new IoWebUi(createAdapter());
		const res = await webUi.handleCommand('web.unknown', {});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('UNKNOWN_COMMAND');
	});

	it('rejects ui.bootstrap because IoWebUi is web-only in AP4', async () => {
		const webUi = new IoWebUi(createAdapter());
		const res = await webUi.handleCommand('ui.bootstrap', null);
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('UNKNOWN_COMMAND');
	});
});
