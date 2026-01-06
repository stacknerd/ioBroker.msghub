'use strict';

const { expect } = require('chai');
const { IoManagedMeta } = require('./IoManagedMeta');

function makeAdapter({ namespace = 'msghub.0', objects: initialObjects, states: initialStates } = {}) {
	const objects = new Map(Object.entries(initialObjects || {}));
	const states = new Map(Object.entries(initialStates || {}));

	const adapter = {
		namespace,
		i18n: {
			getTranslatedObject: s => ({ en: String(s), de: String(s) }),
		},
		log: {
			debug() {},
			warn() {},
		},
		getObjectAsync: async id => objects.get(id),
		getForeignObjectAsync: async id => objects.get(id) || null,
		getStateAsync: async id => states.get(id),
		setStateAsync: async (id, state) => states.set(id, state),
		setObjectNotExistsAsync: async (id, obj) => {
			if (!objects.has(id)) {
				objects.set(id, obj);
			}
		},
		extendForeignObjectAsync: async (id, patch) => {
			const cur = objects.get(id) || {};
			const next = { ...cur, ...patch };

			const curCommon = cur && typeof cur.common === 'object' && cur.common ? cur.common : {};
			const patchCommon = patch && typeof patch.common === 'object' && patch.common ? patch.common : {};
			next.common = { ...curCommon, ...patchCommon };

			const curCustom =
				curCommon && typeof curCommon.custom === 'object' && curCommon.custom ? curCommon.custom : {};
			const patchCustom =
				patchCommon && typeof patchCommon.custom === 'object' && patchCommon.custom ? patchCommon.custom : {};
			const mergedCustom = { ...curCustom, ...patchCustom };
			for (const [key, val] of Object.entries(patchCustom)) {
				if (val && typeof val === 'object' && !Array.isArray(val) && curCustom[key] && typeof curCustom[key] === 'object') {
					const curEntry = curCustom[key];
					const patchEntry = val;
					mergedCustom[key] = { ...curEntry, ...patchEntry };
				}
			}
			next.common.custom = mergedCustom;

			objects.set(id, next);
		},
		getObjectViewAsync: async (design, search, params) => {
			if (design !== 'system' || search !== 'custom') {
				return { rows: [] };
			}
			const startkey = typeof params?.startkey === 'string' ? params.startkey : '';
			const rows = [];
			for (const obj of objects.values()) {
				const custom = obj?.common?.custom;
				if (custom && typeof custom === 'object' && custom[startkey]) {
					rows.push({ id: obj._id, doc: obj });
				}
			}
			return { rows };
		},
	};

	return { adapter, objects, states };
}

describe('IoManagedMeta janitor', () => {
	it('marks managedMessage=false and disables custom.enabled when orphaned and mode is empty', async () => {
		const foreignId = 'hue.0.demo.state';
		const watchlistStateId = 'IngestDemo.0.watchlist';
		const { adapter, objects } = makeAdapter({
			objects: {
				[foreignId]: {
					_id: foreignId,
					type: 'state',
					common: {
						custom: {
							'msghub.0': {
								enabled: true,
								mode: '',
								'managedMeta-managedBy': 'msghub.0.IngestDemo.0',
								'managedMeta-managedText': 'x',
								'managedMeta-managedSince': '2025-01-01T00:00:00.000Z',
								'managedMeta-managedMessage': true,
							},
						},
					},
				},
				[watchlistStateId]: { _id: `msghub.0.${watchlistStateId}`, type: 'state', common: {}, native: {} },
			},
			states: {
				// Watchlist exists but does not contain the id => orphan.
				[watchlistStateId]: { val: '[]', ack: true },
			},
		});

		const mm = new IoManagedMeta(adapter, { hostName: 'Test' });
		try {
			await mm.runJanitorOnce();
		} finally {
			mm.dispose();
		}

		const updated = objects.get(foreignId);
		expect(updated.common.custom['msghub.0']['managedMeta-managedMessage']).to.equal(false);
		expect(updated.common.custom['msghub.0'].enabled).to.equal(false);
	});

	it('keeps managedMessage when id is listed in the watchlist', async () => {
		const foreignId = 'hue.0.demo.state';
		const watchlistStateId = 'IngestDemo.0.watchlist';
		const { adapter, objects } = makeAdapter({
			objects: {
				[foreignId]: {
					_id: foreignId,
					type: 'state',
					common: {
						custom: {
							'msghub.0': {
								enabled: true,
								mode: '',
								'managedMeta-managedBy': 'msghub.0.IngestDemo.0',
								'managedMeta-managedText': 'x',
								'managedMeta-managedSince': '2025-01-01T00:00:00.000Z',
								'managedMeta-managedMessage': true,
							},
						},
					},
				},
				[watchlistStateId]: { _id: `msghub.0.${watchlistStateId}`, type: 'state', common: {}, native: {} },
			},
			states: {
				// Listed => not orphaned.
				[watchlistStateId]: { val: `["${foreignId}"]`, ack: true },
			},
		});

		const mm = new IoManagedMeta(adapter, { hostName: 'Test' });
		try {
			await mm.runJanitorOnce();
		} finally {
			mm.dispose();
		}

		const updated = objects.get(foreignId);
		expect(updated.common.custom['msghub.0']['managedMeta-managedMessage']).to.equal(true);
		expect(updated.common.custom['msghub.0'].enabled).to.equal(true);
	});
});

describe('IoManagedMeta.clearWatchlist', () => {
	const waitFor = async (predicate, { timeoutMs = 500 } = {}) => {
		const started = Date.now();
		// eslint-disable-next-line no-constant-condition
		while (true) {
			if (predicate()) {
				return;
			}
			if (Date.now() - started > timeoutMs) {
				throw new Error('timeout');
			}
			await new Promise(resolve => setImmediate(resolve));
		}
	};

	it('clears the watchlist immediately and cleans objects in the background', async () => {
		const foreignId = 'hue.0.demo.state';
		const watchlistStateId = 'IngestDemo.0.watchlist';
		const { adapter, objects, states } = makeAdapter({
			objects: {
				[foreignId]: {
					_id: foreignId,
					type: 'state',
					common: {
						custom: {
							'msghub.0': {
								enabled: true,
								mode: '',
								'managedMeta-managedBy': 'msghub.0.IngestDemo.0',
								'managedMeta-managedText': 'x',
								'managedMeta-managedSince': '2025-01-01T00:00:00.000Z',
								'managedMeta-managedMessage': true,
							},
						},
					},
				},
				[watchlistStateId]: { _id: `msghub.0.${watchlistStateId}`, type: 'state', common: {}, native: {} },
			},
			states: {
				[watchlistStateId]: { val: `["${foreignId}"]`, ack: true },
			},
		});

		const mm = new IoManagedMeta(adapter, { hostName: 'Test' });
		try {
			await mm.clearWatchlist({ type: 'IngestDemo', instanceId: 0 });
			expect(states.get(watchlistStateId)).to.deep.equal({ val: '[]', ack: true });

			await waitFor(() => objects.get(foreignId)?.common?.custom?.['msghub.0']?.['managedMeta-managedMessage'] === false);
			expect(objects.get(foreignId).common.custom['msghub.0'].enabled).to.equal(false);
		} finally {
			mm.dispose();
		}
	});
});
