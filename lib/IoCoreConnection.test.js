'use strict';

const { expect } = require('chai');

const { IoCoreConnection } = require('./IoCoreConnection');

describe('IoCoreConnection', () => {
	function createAdapter() {
		const objectCalls = [];
		const stateCalls = [];
		return {
			adapter: {
				namespace: 'msghub.0',
				async setObjectNotExistsAsync(id, obj) {
					objectCalls.push([id, obj]);
				},
				async setStateAsync(id, state) {
					stateCalls.push([id, state]);
				},
			},
			objectCalls,
			stateCalls,
		};
	}

	it('initializes official info.connection state with boolean indicator contract', async () => {
		const { adapter, objectCalls, stateCalls } = createAdapter();
		const coreConnection = new IoCoreConnection(adapter);

		await coreConnection.init();

		expect(objectCalls).to.have.length(1);
		expect(objectCalls[0][0]).to.equal('info.connection');
		expect(objectCalls[0][1]).to.deep.equal({
			type: 'state',
			common: {
				name: 'Core connection',
				type: 'boolean',
				role: 'indicator.connected',
				read: true,
				write: false,
				def: false,
			},
			native: {},
		});
		expect(stateCalls).to.deep.equal([['info.connection', { val: false, ack: true }]]);
		expect(coreConnection.getRuntimeAbout()).to.deep.equal({
			scope: 'core-link',
			connected: false,
			mode: 'local',
		});
	});

	it('marks connected from local health snapshot and exposes runtime.about fragment', async () => {
		const { adapter, stateCalls } = createAdapter();
		const coreConnection = new IoCoreConnection(adapter);

		await coreConnection.markFromHealth({ connected: true, mode: 'local' });

		expect(stateCalls).to.deep.equal([['info.connection', { val: true, ack: true }]]);
		expect(coreConnection.getRuntimeAbout()).to.deep.equal({
			scope: 'core-link',
			connected: true,
			mode: 'local',
		});
	});

	it('reports local health true for a minimal ready msgStore surface', () => {
		const { adapter } = createAdapter();
		const coreConnection = new IoCoreConnection(adapter);

		const health = coreConnection.checkHealthLocal({
			msgStore: {
				getMessages() {
					return [];
				},
				addMessage() {},
				msgIngest: { start() {} },
				msgNotify: {},
			},
		});

		expect(health).to.deep.equal({ connected: true, mode: 'local' });
	});

	it('reports local health false when msgStore surface is incomplete', () => {
		const { adapter } = createAdapter();
		const coreConnection = new IoCoreConnection(adapter);

		const health = coreConnection.checkHealthLocal({ msgStore: { getMessages() {} } });

		expect(health).to.deep.equal({ connected: false, mode: 'local' });
	});
});
