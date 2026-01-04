'use strict';

const toFiniteNumber = v => {
	if (typeof v === 'number' && Number.isFinite(v)) {
		return v;
	}
	if (typeof v === 'string' && v.trim() !== '') {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}
	return null;
};

class FreshnessRule {
	static computeEveryMs(cfg) {
		const value = toFiniteNumber(cfg?.fresh?.everyValue);
		const unit = toFiniteNumber(cfg?.fresh?.everyUnit);
		if (!value || !unit || value <= 0 || unit <= 0) {
			return null;
		}
		return Math.trunc(value * unit * 1000);
	}

	static computeEvaluateBy(cfg) {
		const v = typeof cfg?.fresh?.evaluateBy === 'string' ? cfg.fresh.evaluateBy.trim().toLowerCase() : '';
		return v === 'lc' ? 'lc' : 'ts';
	}

	static computeRemindEveryMs(cfg) {
		const value = toFiniteNumber(cfg?.msg?.remindValue);
		const unit = toFiniteNumber(cfg?.msg?.remindUnit);
		if (!value || !unit || value <= 0 || unit <= 0) {
			return null;
		}
		return Math.trunc(value * unit * 1000);
	}

	static computeResetDelayMs(cfg) {
		const value = toFiniteNumber(cfg?.msg?.resetDelayValue);
		const unit = toFiniteNumber(cfg?.msg?.resetDelayUnit);
		if (!value || !unit || value <= 0 || unit <= 0) {
			return 0;
		}
		return Math.trunc(value * unit * 1000);
	}
}

module.exports = { FreshnessRule };

