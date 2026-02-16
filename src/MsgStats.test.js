'use strict';

const { expect } = require('chai');
const { MsgConstants } = require('./MsgConstants');
const { MsgStorage } = require('./MsgStorage');
const { MsgArchive } = require('./MsgArchive');
const { MsgStats } = require('./MsgStats');
const { IoArchiveIobroker } = require('../lib/IoArchiveIobroker');
const { IoStorageIobroker } = require('../lib/IoStorageIobroker');

function createAdapter() {
	const files = new Map();
	const objects = new Map();

	const adapter = {
		name: 'msghub',
		namespace: 'msghub.0',
		locale: 'en-US',
		log: {
			warn: () => {},
			debug: () => {},
			info: () => {},
			silly: () => {},
		},
		getObjectAsync: async id => objects.get(id),
		setObjectAsync: async (id, obj) => {
			objects.set(id, obj);
		},
		readFileAsync: async (metaId, fileName) => {
			const key = `${metaId}/${fileName}`;
			if (!files.has(key)) {
				throw new Error('ENOENT');
			}
			return { file: Buffer.from(files.get(key)) };
		},
		writeFileAsync: async (metaId, fileName, data) => {
			const key = `${metaId}/${fileName}`;
			files.set(key, data);
		},
		delFileAsync: async (metaId, fileName) => {
			const key = `${metaId}/${fileName}`;
			files.delete(key);
		},
	};

	return { adapter, files, objects };
}

function withFixedNow(now, fn) {
	const original = Date.now;
	Date.now = () => now;
	try {
		return fn();
	} finally {
		Date.now = original;
	}
}

function createStorageBackendFactory(adapter, baseDir = 'data') {
	return () =>
		new IoStorageIobroker({
			adapter,
			metaId: adapter.namespace,
			baseDir,
		});
}

describe('MsgStats', () => {
	it('computes current + schedule + done snapshots', async () => {
		const { adapter } = createAdapter();

		const msgStorage = new MsgStorage(adapter, {
			writeIntervalMs: 0,
			createStorageBackend: createStorageBackendFactory(adapter, 'data'),
		});
		await msgStorage.init();
		await msgStorage.writeJson([{ ref: 'x' }]);

		const msgArchive = new MsgArchive(adapter, {
			baseDir: 'data/archive',
			flushIntervalMs: 0,
			createStorageBackend: onMutated =>
				new IoArchiveIobroker({
					adapter,
					metaId: adapter.namespace,
					baseDir: 'data/archive',
					fileExtension: 'jsonl',
					onMutated,
				}),
			archiveRuntime: {
				configuredStrategyLock: '',
				effectiveStrategy: 'iobroker',
				effectiveStrategyReason: 'test-default',
				nativeRootDir: '',
				nativeProbeError: '',
			},
		});

		const ts = (y, m, d, h) => new Date(y, m - 1, d, h, 0, 0, 0).getTime();
		const now = ts(2026, 1, 15, 12);

		const messages = [
			{
				ref: 't.overdue',
				kind: MsgConstants.kind.task,
				level: MsgConstants.level.notice,
				lifecycle: { state: MsgConstants.lifecycle.state.open },
				timing: { dueAt: ts(2026, 1, 14, 10) },
			},
			{
				ref: 't.today',
				kind: MsgConstants.kind.task,
				level: MsgConstants.level.notice,
				lifecycle: { state: MsgConstants.lifecycle.state.open },
				timing: { dueAt: ts(2026, 1, 15, 18) },
			},
			{
				ref: 'a.tomorrow',
				kind: MsgConstants.kind.appointment,
				level: MsgConstants.level.notice,
				lifecycle: { state: MsgConstants.lifecycle.state.open },
				timing: { startAt: ts(2026, 1, 16, 9) },
			},
			{
				ref: 'd.deleted',
				kind: MsgConstants.kind.task,
				level: MsgConstants.level.notice,
				lifecycle: { state: MsgConstants.lifecycle.state.deleted },
				timing: { dueAt: ts(2026, 1, 16, 9) },
			},
		];

		const store = { fullList: messages, msgStorage, msgArchive };
		const stats = new MsgStats(adapter, MsgConstants, store, {
			createStorageBackend: createStorageBackendFactory(adapter, 'data'),
		});

		withFixedNow(now, () => {
			stats.recordClosed({
				ref: 'done.1',
				kind: MsgConstants.kind.task,
				lifecycle: { state: MsgConstants.lifecycle.state.closed, stateChangedAt: now },
			});
		});
		stats.onUnload(); // clear throttled rollup timer

		const snap = await withFixedNow(now, async () => await stats.getStats());

		expect(snap).to.have.property('current');
		expect(snap.current.total).to.equal(4);
		expect(snap.current.byKind).to.have.property(MsgConstants.kind.task, 3);

		expect(snap).to.have.property('schedule');
		expect(snap.schedule.total).to.equal(3); // deleted is excluded
		expect(snap.schedule.overdue).to.equal(1);
		expect(snap.schedule.today).to.equal(1);
		expect(snap.schedule.tomorrow).to.equal(1);
		expect(snap.schedule.byKind[MsgConstants.kind.task].total).to.equal(2);
		expect(snap.schedule.byKind[MsgConstants.kind.appointment].total).to.equal(1);

		expect(snap).to.have.property('done');
		expect(snap.done.today.total).to.equal(1);
		expect(snap.done.thisWeek.total).to.equal(1);
		expect(snap.done.thisMonth.total).to.equal(1);

		expect(snap).to.have.property('io');
		expect(snap.io.storage).to.have.property('lastPersistedAt');
		expect(snap.io.archive).to.have.property('keepPreviousWeeks');
	});
});
