'use strict';

const { expect } = require('chai');
const { handleActionPayload } = require('./IoActionEffects');

describe('IoActionEffects.handleActionPayload', () => {
	it('sets foreign states for iobroker.state.set effects (best-effort)', async () => {
		const calls = [];
		const adapter = {
			log: { warn: () => {} },
			setForeignStateAsync: async (id, state) => {
				calls.push([id, state]);
			},
		};

		handleActionPayload(
			{ effects: [{ kind: 'iobroker.state.set', id: 'userData.0.foo', val: 1, ack: true }] },
			{ adapter },
		);

		await new Promise(resolve => setTimeout(resolve, 0));
		expect(calls).to.deep.equal([['userData.0.foo', { val: 1, ack: true }]]);
	});

	it('blocks blacklisted namespaces (system.*, msghub.*)', async () => {
		const calls = [];
		const warns = [];
		const adapter = {
			log: { warn: msg => warns.push(String(msg)) },
			setForeignStateAsync: async (id, state) => {
				calls.push([id, state]);
			},
		};

		handleActionPayload(
			{
				effects: [
					{ kind: 'iobroker.state.set', id: 'system.adapter.admin.0.alive', val: false, ack: true },
					{ kind: 'iobroker.state.set', id: 'msghub.0.NotifyStates.0', val: true, ack: true },
				],
			},
			{ adapter },
		);

		await new Promise(resolve => setTimeout(resolve, 0));
		expect(calls).to.deep.equal([]);
		expect(warns.join('\n')).to.match(/blocked state write/);
	});
});
