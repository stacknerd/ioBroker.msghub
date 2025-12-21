class MsgFactory {
	constructor(adapter) {
		if (!adapter) {
			throw new Error('MsgFactory: adapter is required');
		}
		this.adapter = adapter;

		// create LevelSets once
		this.levelValueSet = new Set(Object.values(this.adapter.msgconst.level));
		this.kindValueSet = new Set(Object.values(this.adapter.msgconst.kind));
		this.originTypeValueSet = new Set(Object.values(this.adapter.msgconst.origin.type));
		this.enumSetStrings = new Map([
			[this.levelValueSet, Array.from(this.levelValueSet).join(', ')],
			[this.kindValueSet, Array.from(this.kindValueSet).join(', ')],
			[this.originTypeValueSet, Array.from(this.originTypeValueSet).join(', ')],
		]);
	}

	createMessage({ ref, title, text, level, kind, origin = {}, timing = {}, details = {} } = {}) {
		try {
			const normkind = this._normalizeMsgEnum(kind, this.kindValueSet, 'kind', { required: true });
			const msg = {
				ref: this._normalizeMsgRef(ref),
				title: this._normalizeMsgString(title, 'title', { required: true }),
				text: this._normalizeMsgString(text, 'text', { required: true }),
				level: this._normalizeMsgEnum(level, this.levelValueSet, 'level', { required: true }),
				kind: normkind,
				origin: this._normalizeMsgOrigin(origin),
				timing: this._normalineMsgTiming(timing, normkind),
				details: this._normalizeMsgDetails(details),
			};

			return this._removeUndefinedKeys(msg);
		} catch (e) {
			if (this.adapter?.log?.error) {
				this.adapter.log.error(e);
			}
		}

		return null;
	}

	// ======================================
	//        normalize basics
	// ======================================

	_normalizeMsgString(value, field, { required = false, trim = true, fallback = undefined } = {}) {
		if (typeof value !== 'string') {
			if (required) {
				throw new TypeError(`createMessage: ${field} must be a string, reiceived '${typeof value}' instead`);
			}

			this.adapter?.log?.warn?.(`createMessage: ${field} must be string, reiceived '${typeof value}' instead`);
			return fallback;
		}
		const text = trim ? value.trim() : value;
		if (required && !text) {
			throw new TypeError(`createMessage: ${field} is required but a empty string`);
		} else if (!text) {
			this.adapter?.log?.warn?.(`createMessage: ${field} is a empty string`);
			return fallback;
		}
		return text;
	}

	_normalizeMsgNumber(value, field, { required = false, fallback = undefined } = {}) {
		if (typeof value !== 'number') {
			if (required) {
				throw new TypeError(`createMessage: ${field} must be a number, reiceived '${typeof value}' instead`);
			}

			this.adapter?.log?.warn?.(`createMessage: ${field} must be number, reiceived '${typeof value}' instead`);
			return fallback;
		}
		const ts = Number.isFinite(value) ? Math.trunc(value) : NaN;
		if (required && !(ts > 0)) {
			throw new TypeError(`createMessage: ${field} is required but zero`);
		} else if (!(ts > 0)) {
			this.adapter?.log?.warn?.(`createMessage: ${field} is zero`);
			return fallback;
		}
		return ts;
	}

	_normalizeMsgTime(value, field, { required = false, fallback = undefined } = {}) {
		const ts = this._normalizeMsgNumber(value, field, { required, fallback });

		if (!this._isPlausibleUnixMs(ts)) {
			throw new TypeError(`createMessage: ${field} is not a plausible UnixMs timestamp (received:'${ts}')`);
		}

		return ts;
	}

	_normalizeMsgEnum(value, valueset, field, { required = false, fallback = undefined } = {}) {
		if (value === undefined || value === null) {
			if (required) {
				throw new TypeError(`createMessage: ${field} missing`);
			}
			return fallback;
		}

		if (!valueset.has(value)) {
			const valuesetString = this._getEnumSetString(valueset);
			if (required) {
				throw new TypeError(
					`createMessage: ${field} must be one of '${valuesetString}', received '${value}' instead`,
				);
			}
			this.adapter?.log?.warn?.(
				`createMessage: ${field} must be one of '${valuesetString}', received '${value}' instead`,
			);
			return fallback;
		}
		return value;
	}

	_normalizeMsgArray(value, field) {
		if (value === undefined || value === null) {
			return undefined;
		}
		if (Array.isArray(value)) {
			const normalized = value
				.filter(entry => typeof entry === 'string')
				.map(entry => entry.trim())
				.filter(entry => entry.length > 0);
			if (normalized.length !== value.length) {
				this.adapter?.log?.warn?.(`createMessage: ${field} array contains non-string or empty entries`);
			}
			return normalized.length > 0 ? normalized : undefined;
		}
		if (typeof value === 'string') {
			const normalized = value
				.split(',')
				.map(entry => entry.trim())
				.filter(entry => entry.length > 0);
			return normalized.length > 0 ? normalized : undefined;
		}
		this.adapter?.log?.warn?.(`createMessage: ${field} array must be string[] or comma-separated string`);
		return undefined;
	}

	// ======================================
	//     normalize specific fields
	// ======================================

	_normalizeMsgRef(value) {
		const ref = this._normalizeMsgString(value, 'ref', { required: true });
		// nur druckbare ASCII-Zeichen (Space..~)
		return ref ? ref.replace(/[^\x20-\x7E]/g, '').trim() : ref;
	}

	_normalizeMsgOrigin(value) {
		if (!value || typeof value !== 'object') {
			throw new TypeError(`createMessage: origin must be an object`);
		}
		if (!(typeof value.type === 'string' && value.type.trim() !== '')) {
			throw new TypeError(
				`createMessage: origin.type must be a string, reiceived '${typeof value.type}' instead`,
			);
		}
		const origin = {
			type: this._normalizeMsgEnum(value.type, this.originTypeValueSet, 'origin.type', { required: true }),
			system: value.system ? this._normalizeMsgString(value.system, 'origin.system') : undefined,
			id: value.id ? this._normalizeMsgString(value.id, 'origin.id') : undefined,
		};

		return this._removeUndefinedKeys(origin);
	}

	_normalineMsgTiming(value, kind) {
		const timing = {
			createdAt: Date.now(),
			expiresAt: value.expiresAt ? this._normalizeMsgTime(value.expiresAt, 'timing.expiresAt') : undefined,
			notifyAt: value.notifyAt ? this._normalizeMsgTime(value.notifyAt, 'timing.notifyAt') : undefined,
		};

		if (value.dueAt) {
			if (kind == this.adapter.msgconst.kind.task) {
				// only available on tasks
				timing['dueAt'] = this._normalizeMsgTime(value.dueAt, 'timing.dueAt');
			} else {
				this.adapter?.log?.warn?.(
					`createMessage: timing.dueAt not available on kind == '${kind}' (expected: 'task')`,
				);
			}
		}
		if (value.startAt) {
			if (kind == this.adapter.msgconst.kind.appointment) {
				// only available on tasks
				timing['startAt'] = this._normalizeMsgTime(value.startAt, 'timing.startAt');
			} else {
				this.adapter?.log?.warn?.(
					`createMessage: timing.startAt not available on kind == '${kind}' (expected: 'appointment')`,
				);
			}
		}
		if (value.endAt) {
			if (kind == this.adapter.msgconst.kind.appointment) {
				// only available on tasks
				timing['endAt'] = this._normalizeMsgTime(value.endAt, 'timing.endAt');
			} else {
				this.adapter?.log?.warn?.(
					`createMessage: timing.endAt not available on kind == '${kind}' (expected: 'appointment')`,
				);
			}
		}

		return this._removeUndefinedKeys(timing);
	}

	_normalizeMsgDetails(value) {
		if (!value || typeof value !== 'object') {
			return undefined;
		}
		const details = this._removeUndefinedKeys({
			location: value.location ? this._normalizeMsgString(value.location, 'details.location') : undefined,
			task: value.task ? this._normalizeMsgString(value.task, 'details.task') : undefined,
			reason: value.reason ? this._normalizeMsgString(value.reason, 'details.reason') : undefined,
			tools: value.tools ? this._normalizeMsgArray(value.tools, 'details.tools') : undefined,
			consumables: value.consumables
				? this._normalizeMsgArray(value.consumables, 'details.consumables')
				: undefined,
		});
		return Object.keys(details).length > 0 ? details : undefined;
	}

	// ======================================
	//       generic Helpers
	// ======================================

	_getEnumSetString(valueset) {
		const cached = this.enumSetStrings?.get(valueset);
		if (cached) {
			return cached;
		}
		const valuesetString = Array.from(valueset).join(', ');
		if (this.enumSetStrings) {
			this.enumSetStrings.set(valueset, valuesetString);
		}
		return valuesetString;
	}

	_removeUndefinedKeys(obj) {
		return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
	}

	_isPlausibleUnixMs(ts, { min = Date.UTC(2000, 0, 1), max = Date.UTC(2100, 0, 1) } = {}) {
		return typeof ts === 'number' && Number.isFinite(ts) && Number.isInteger(ts) && ts >= min && ts <= max;
	}
}

module.exports = { MsgFactory };
