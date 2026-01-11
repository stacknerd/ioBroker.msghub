'use strict';

const { expect } = require('chai');
const { MsgNotificationPolicy } = require('./MsgNotificationPolicy');

describe('MsgNotificationPolicy', () => {
	describe('isInQuietHours', () => {
		it('detects non-cross-midnight windows', () => {
			const quietHours = { enabled: true, startMin: 8 * 60, endMin: 10 * 60, maxLevel: 20, spreadMs: 0 };
			const tIn = new Date(2020, 0, 1, 9, 0, 0, 0).getTime();
			const tOut = new Date(2020, 0, 1, 7, 59, 0, 0).getTime();
			expect(MsgNotificationPolicy.isInQuietHours(tIn, quietHours)).to.equal(true);
			expect(MsgNotificationPolicy.isInQuietHours(tOut, quietHours)).to.equal(false);
		});

		it('detects cross-midnight windows', () => {
			const quietHours = { enabled: true, startMin: 22 * 60, endMin: 6 * 60, maxLevel: 20, spreadMs: 0 };
			const tLate = new Date(2020, 0, 1, 23, 0, 0, 0).getTime();
			const tEarly = new Date(2020, 0, 2, 1, 0, 0, 0).getTime();
			const tDay = new Date(2020, 0, 2, 12, 0, 0, 0).getTime();
			expect(MsgNotificationPolicy.isInQuietHours(tLate, quietHours)).to.equal(true);
			expect(MsgNotificationPolicy.isInQuietHours(tEarly, quietHours)).to.equal(true);
			expect(MsgNotificationPolicy.isInQuietHours(tDay, quietHours)).to.equal(false);
		});
	});

	describe('computeQuietRescheduleTs', () => {
		it('uses quiet-hours end and spread jitter', () => {
			const quietHours = { enabled: true, startMin: 22 * 60, endMin: 6 * 60, maxLevel: 20, spreadMs: 60_000 };
			const now = new Date(2020, 0, 1, 23, 0, 0, 0).getTime();
			const end = new Date(2020, 0, 2, 6, 0, 0, 0).getTime();
			const ts = MsgNotificationPolicy.computeQuietRescheduleTs({ now, quietHours, randomFn: () => 0.5 });
			expect(ts).to.equal(end + 30_000);
		});
	});

	describe('shouldSuppressDue', () => {
		it('suppresses only repeats within quiet hours up to maxLevel', () => {
			const quietHours = { enabled: true, startMin: 22 * 60, endMin: 6 * 60, maxLevel: 20, spreadMs: 0 };
			const now = new Date(2020, 0, 1, 23, 0, 0, 0).getTime();
			const first = { level: 10, timing: { notifiedAt: {} } };
			const repeat = { level: 10, timing: { notifiedAt: { due: now - 1 } } };
			const high = { level: 30, timing: { notifiedAt: { due: now - 1 } } };
			expect(MsgNotificationPolicy.shouldSuppressDue({ msg: first, now, quietHours })).to.equal(false);
			expect(MsgNotificationPolicy.shouldSuppressDue({ msg: repeat, now, quietHours })).to.equal(true);
			expect(MsgNotificationPolicy.shouldSuppressDue({ msg: high, now, quietHours })).to.equal(false);
		});
	});
});

