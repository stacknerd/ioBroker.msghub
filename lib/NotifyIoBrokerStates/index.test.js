'use strict';

const sinon = require('sinon');
const { expect } = require('chai');

const { NotifyIoBrokerStates } = require('./index');

const flushPromises = () => new Promise(resolve => setImmediate(resolve));

function createAdapterMock() {
	return {
		namespace: 'msghub.0',
		log: {
			warn: sinon.stub(),
		},
		setObjectNotExistsAsync: sinon.stub().resolves(),
		setStateAsync: sinon.stub().resolves(),
	};
}

describe('NotifyIoBrokerStates', () => {
	it('throws when adapter is missing', () => {
		expect(() => NotifyIoBrokerStates()).to.throw(/adapter is required/i);
	});

	it('throws when options.pluginBaseObjectId is missing', () => {
		const adapter = createAdapterMock();
		expect(() => NotifyIoBrokerStates(adapter, {})).to.throw(/pluginBaseObjectId is required/i);
	});

	it('pre-creates all states under the base id (without namespace prefix)', () => {
		const adapter = createAdapterMock();
		NotifyIoBrokerStates(adapter, { pluginBaseObjectId: 'msghub.0.NotifyIoBrokerStates.0' });

		expect(adapter.setObjectNotExistsAsync.callCount).to.equal(40);
		expect(
			adapter.setObjectNotExistsAsync.calledWithMatch('NotifyIoBrokerStates.0.Latest.due', sinon.match.object),
		).to.equal(true);
		expect(
			adapter.setObjectNotExistsAsync.calledWithMatch(
				'NotifyIoBrokerStates.0.byLevel.warning.updated',
				sinon.match.object,
			),
		).to.equal(true);
	});

	it('writes Latest/byKind/byLevel using event key normalization (update -> updated)', async () => {
		const adapter = createAdapterMock();
		const plugin = NotifyIoBrokerStates(adapter, { pluginBaseObjectId: 'msghub.0.NotifyIoBrokerStates.0' });

		const notification = {
			kind: 'task',
			level: '20',
			payload: new Map([['a', 1]]),
		};
		plugin.onNotifications('update', [notification]);
		await flushPromises();
		await flushPromises();

		const calls = adapter.setStateAsync.getCalls().map(c => ({
			id: c.args[0],
			val: c.args[1]?.val,
			ack: c.args[1]?.ack,
		}));

		expect(calls.map(c => c.id)).to.include('NotifyIoBrokerStates.0.Latest.updated');
		expect(calls.map(c => c.id)).to.include('NotifyIoBrokerStates.0.byKind.task.updated');
		expect(calls.map(c => c.id)).to.include('NotifyIoBrokerStates.0.byLevel.warning.updated');

		for (const call of calls) {
			expect(call.ack).to.equal(true);
			expect(call.val).to.be.a('string');
		}

		const latest = calls.find(c => c.id.endsWith('.Latest.updated'));
		const latestParsed = JSON.parse(latest.val);
		expect(latestParsed.payload).to.deep.equal({ __msghubType: 'Map', value: [['a', 1]] });
	});

	it('writes an array to Latest when multiple notifications are provided', async () => {
		const adapter = createAdapterMock();
		const plugin = NotifyIoBrokerStates(adapter, { pluginBaseObjectId: 'NotifyIoBrokerStates.0' });

		plugin.onNotifications('due', [
			{ kind: 'status', level: 10, text: 'one' },
			{ kind: 'status', level: 10, text: 'two' },
		]);
		await flushPromises();
		await flushPromises();

		const latestCall = adapter.setStateAsync
			.getCalls()
			.map(c => ({ id: c.args[0], val: c.args[1]?.val }))
			.find(c => c.id === 'NotifyIoBrokerStates.0.Latest.due');

		const latestParsed = JSON.parse(latestCall.val);
		expect(latestParsed).to.have.length(2);
		expect(latestParsed.map(n => n.text)).to.deep.equal(['one', 'two']);
	});

	it('ignores unknown events and invalid notification lists', async () => {
		const adapter = createAdapterMock();
		const plugin = NotifyIoBrokerStates(adapter, { pluginBaseObjectId: 'NotifyIoBrokerStates.0' });

		plugin.onNotifications('unknown', [{ kind: 'task', level: 10 }]);
		plugin.onNotifications('due', []);
		plugin.onNotifications('due', null);
		await flushPromises();

		expect(adapter.setStateAsync.called).to.equal(false);
	});
});

