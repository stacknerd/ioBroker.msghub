'use strict';

/**
 * @param {any} v Value.
 * @returns {boolean} True when v is a plain object-like value.
 */
function isObject(v) {
	return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Normalize a base URL for provider calls.
 *
 * @param {any} baseUrl Base URL input.
 * @returns {string} Normalized base URL without trailing slash.
 */
function normalizeBaseUrl(baseUrl) {
	const raw = typeof baseUrl === 'string' ? baseUrl.trim() : '';
	if (!raw) {
		return 'https://api.openai.com/v1';
	}
	return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/**
 * @param {any} v Value.
 * @returns {number|null} Truncated finite number or null.
 */
function safeTruncNumber(v) {
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * @param {any} v Value.
 * @returns {'fast'|'balanced'|'best'} Normalized quality.
 */
function normalizeQuality(v) {
	const q = typeof v === 'string' ? v.trim().toLowerCase() : '';
	if (q === 'fast' || q === 'balanced' || q === 'best') {
		return q;
	}
	return 'balanced';
}

/**
 * MsgAi
 * =====
 *
 * Best-effort AI enhancement service for plugins (`ctx.api.ai.*`).
 */
class MsgAi {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance (logging only).
	 * @param {object} [options] Options.
	 * @param {boolean} [options.enabled] Feature flag (even when false, getStatus() still reports details).
	 * @param {string} [options.provider] Provider id (v1: 'openai').
	 * @param {object} [options.openai] OpenAI provider options.
	 * @param {string} [options.openai.apiKey] API key (decrypted).
	 * @param {string} [options.openai.baseUrl] Base URL, defaults to https://api.openai.com/v1.
	 * @param {string} [options.openai.model] Default model name (fallback), e.g. 'gpt-4o-mini'.
	 * @param {{ fast?: string, balanced?: string, best?: string }} [options.openai.modelsByQuality] Model mapping by `hints.quality`.
	 * @param {Array<{ purpose: string, quality?: ('fast'|'balanced'|'best')|null, model: string }>} [options.openai.purposeModelOverrides]
	 *   Optional purpose-based overrides. Precedence: (purpose+quality) > (purpose-any-quality) > modelsByQuality > model.
	 * @param {number} [options.timeoutMs] Default request timeout (ms).
	 * @param {number} [options.maxConcurrency] Max concurrent requests (global).
	 * @param {number} [options.rpm] Max requests/minute (per plugin regId).
	 * @param {number} [options.cacheTtlMs] Default cache TTL when request.cache.ttlMs is missing.
	 * @param {Function} [options.fetch] Fetch implementation override (tests).
	 * @param {Function} [options.now] Time source override (tests), must return ms timestamp.
	 */
	constructor(adapter, options = {}) {
		this.adapter = adapter || null;
		const enabled = options?.enabled === true;
		const provider = typeof options?.provider === 'string' ? options.provider.trim().toLowerCase() : '';

		const openai =
			options && options.openai && typeof options.openai === 'object' && !Array.isArray(options.openai)
				? options.openai
				: {};
		const apiKey = typeof openai.apiKey === 'string' ? openai.apiKey.trim() : '';
		const baseUrl = normalizeBaseUrl(openai.baseUrl);

		const modelsByQualityRaw =
			openai.modelsByQuality &&
			typeof openai.modelsByQuality === 'object' &&
			!Array.isArray(openai.modelsByQuality)
				? openai.modelsByQuality
				: {};
		const modelFast = typeof modelsByQualityRaw.fast === 'string' ? modelsByQualityRaw.fast.trim() : '';
		const modelBalanced = typeof modelsByQualityRaw.balanced === 'string' ? modelsByQualityRaw.balanced.trim() : '';
		const modelBest = typeof modelsByQualityRaw.best === 'string' ? modelsByQualityRaw.best.trim() : '';

		const modelRaw = typeof openai.model === 'string' ? openai.model.trim() : '';
		const defaultModel = modelRaw || modelBalanced || 'gpt-4o-mini';
		const purposeModelOverrides = this._normalizePurposeModelOverrides(openai.purposeModelOverrides);

		const timeoutMs = safeTruncNumber(options?.timeoutMs) ?? 30000;
		const maxConcurrency = Math.max(1, safeTruncNumber(options?.maxConcurrency) ?? 2);
		const rpm = Math.max(0, safeTruncNumber(options?.rpm) ?? 0);
		const cacheTtlMs = Math.max(0, safeTruncNumber(options?.cacheTtlMs) ?? 0);

		this._cfg = Object.freeze({
			enabled,
			provider,
			openai: Object.freeze({
				apiKey,
				baseUrl,
				defaultModel,
				modelsByQuality: Object.freeze({
					fast: modelFast || defaultModel,
					balanced: modelBalanced || defaultModel,
					best: modelBest || defaultModel,
				}),
				purposeModelOverrides,
			}),
			timeoutMs,
			maxConcurrency,
			rpm,
			cacheTtlMs,
		});

		this._fetch = typeof options?.fetch === 'function' ? options.fetch : globalThis.fetch;
		this._now = typeof options?.now === 'function' ? options.now : Date.now;

		this._queue = [];
		this._active = 0;

		this._cache = new Map(); // cacheKey -> { expiresAt, result }
		this._rate = new Map(); // callerKey -> number[] timestamps (ms)

		this.adapter?.log?.info?.(
			`MsgAi initialized: enabled=${enabled}, provider=${provider || 'n/a'}, baseUrl=${baseUrl}, model=${defaultModel}, maxConcurrency=${maxConcurrency}, rpm=${rpm}, cacheTtlMs=${cacheTtlMs}`,
		);
	}

	/**
	 * @returns {{ enabled: boolean, provider?: string, reason?: string }} Current AI availability for this adapter instance.
	 */
	getStatus() {
		const { enabled, provider } = this._cfg;
		if (!enabled) {
			return Object.freeze({ enabled: false, ...(provider ? { provider } : {}), reason: 'disabled' });
		}
		if (provider !== 'openai') {
			return Object.freeze({ enabled: false, ...(provider ? { provider } : {}), reason: 'unsupported provider' });
		}
		if (!this._cfg.openai.apiKey) {
			return Object.freeze({ enabled: false, provider: 'openai', reason: 'missing api key' });
		}
		if (typeof this._fetch !== 'function') {
			return Object.freeze({ enabled: false, provider: 'openai', reason: 'fetch not available' });
		}
		return Object.freeze({ enabled: true, provider: 'openai' });
	}

	/**
	 * @param {object} request Request payload.
	 * @param {{ regId?: string }|null} [caller] Caller identity (used for rate limiting/caching partition).
	 * @returns {Promise<{ ok: true, value: string, meta: object } | { ok: false, error: object, meta?: object }>} Result.
	 */
	text(request, caller = null) {
		return this._enqueue('text', request, caller);
	}

	/**
	 * @param {object} request Request payload.
	 * @param {{ regId?: string }|null} [caller] Caller identity (used for rate limiting/caching partition).
	 * @returns {Promise<{ ok: true, value: any, meta: object } | { ok: false, error: object, meta?: object }>} Result.
	 */
	json(request, caller = null) {
		return this._enqueue('json', request, caller);
	}

	/**
	 * Create a caller-bound API wrapper (used by IoPlugins to bind `ctx.meta.plugin`).
	 *
	 * @param {{ regId?: string }|null} caller Caller identity.
	 * @returns {{ getStatus: Function, text: Function, json: Function }} Caller-bound facade.
	 */
	createCallerApi(caller) {
		const stableCaller = caller && typeof caller === 'object' ? Object.freeze({ regId: caller.regId }) : null;
		return Object.freeze({
			getStatus: () => this.getStatus(),
			text: request => this.text(request, stableCaller),
			json: request => this.json(request, stableCaller),
		});
	}

	/**
	 * @param {'text'|'json'} kind Request kind.
	 * @param {any} request Request payload.
	 * @param {{ regId?: string }|null} caller Caller identity.
	 * @returns {Promise<any>} Promise resolving with an AiResult.
	 */
	_enqueue(kind, request, caller) {
		return new Promise(resolve => {
			this._queue.push({ kind, request, caller, resolve });
			this._drainQueue();
		});
	}

	/**
	 * @returns {void}
	 */
	_drainQueue() {
		while (this._active < this._cfg.maxConcurrency && this._queue.length) {
			const job = this._queue.shift();
			if (!job) {
				return;
			}
			this._active += 1;
			this._runJob(job)
				.then(job.resolve)
				.catch(e => {
					this.adapter?.log?.warn?.(`MsgAi: INTERNAL error: ${String(e?.message || e)}`);
					// Must never reject; map to internal error.
					job.resolve({
						ok: false,
						error: { code: 'INTERNAL', message: String(e?.message || e) },
					});
				})
				.finally(() => {
					this._active -= 1;
					this._drainQueue();
				});
		}
	}

	/**
	 * @param {object} job Job payload.
	 * @param {'text'|'json'} job.kind Request kind.
	 * @param {any} job.request Request payload.
	 * @param {{ regId?: string }|null} job.caller Caller identity.
	 * @returns {Promise<any>} Promise resolving with an AiResult.
	 */
	async _runJob({ kind, request, caller }) {
		const status = this.getStatus();
		if (!status.enabled) {
			return { ok: false, error: { code: 'NOT_CONFIGURED', message: status.reason || 'not configured' } };
		}

		const safeReq = isObject(request) ? request : {};
		const purpose = typeof safeReq.purpose === 'string' ? safeReq.purpose.trim() : '';
		if (!purpose) {
			return { ok: false, error: { code: 'BAD_REQUEST', message: 'purpose is required' } };
		}

		const messages = Array.isArray(safeReq.messages) ? safeReq.messages : null;
		if (!messages || !messages.length) {
			return { ok: false, error: { code: 'BAD_REQUEST', message: 'messages[] is required' } };
		}

		const callerKey = this._callerKey(caller);
		if (!this._checkRateLimit(callerKey)) {
			return { ok: false, error: { code: 'RATE_LIMITED', message: 'rate limited' } };
		}

		const cache = isObject(safeReq.cache) ? safeReq.cache : null;
		const cacheKey = typeof cache?.key === 'string' ? cache.key.trim() : '';
		if (cacheKey) {
			const cached = this._cacheGet(`${callerKey}|${cacheKey}`);
			if (cached) {
				return cached;
			}
		}

		const startedAt = this._now();
		const timeoutMs = Math.max(1, safeTruncNumber(safeReq.timeoutMs) ?? this._cfg.timeoutMs);
		const hints = isObject(safeReq.hints) ? safeReq.hints : {};
		const quality = normalizeQuality(hints.quality);
		const model = this._resolveModel({ purpose, quality });

		const temperatureRaw = hints.temperature;
		const temperature =
			typeof temperatureRaw === 'number' && Number.isFinite(temperatureRaw) ? temperatureRaw : undefined;

		const maxTokensRaw = hints.maxTokens;
		const maxTokens = safeTruncNumber(maxTokensRaw);

		this.adapter?.log?.debug?.(
			`MsgAi request: caller=${callerKey}, kind=${kind}, purpose=${purpose}, model=${model}, quality=${quality}, timeoutMs=${timeoutMs}, cacheKey=${cacheKey || 'n/a'}`,
		);

		const res = await this._openAiChatCompletions({
			purpose,
			messages,
			model,
			quality,
			temperature,
			maxTokens,
			jsonMode: kind === 'json',
			timeoutMs,
		});

		const meta = Object.freeze({
			...(res && res.meta && typeof res.meta === 'object' ? res.meta : {}),
			durationMs: Math.max(0, this._now() - startedAt),
		});

		let out = res;
		if (res?.ok === true) {
			out = { ok: true, value: res.value, meta };
		} else if (res?.ok === false) {
			out = { ok: false, error: res.error, ...(meta ? { meta } : {}) };
		}

		if (cacheKey) {
			const ttlMs = Math.max(0, safeTruncNumber(cache?.ttlMs) ?? this._cfg.cacheTtlMs);
			if (ttlMs > 0) {
				this._cacheSet(`${callerKey}|${cacheKey}`, out, ttlMs);
			}
		}

		if (out?.ok === false) {
			const code = out?.error?.code ? String(out.error.code) : 'ERROR';
			const message = out?.error?.message ? String(out.error.message) : 'Error';
			this.adapter?.log?.warn?.(
				`MsgAi error: caller=${callerKey}, kind=${kind}, purpose=${purpose}, model=${model}, quality=${quality}, code=${code}, message=${message}`,
			);
		}

		return out;
	}

	/**
	 * @param {{ regId?: string }|null} caller Caller identity.
	 * @returns {string} Caller key used for per-plugin policies.
	 */
	_callerKey(caller) {
		const regId = typeof caller?.regId === 'string' ? caller.regId.trim() : '';
		return regId || 'unknown';
	}

	/**
	 * @param {string} callerKey Caller key.
	 * @returns {boolean} True when allowed by rate limit policy.
	 */
	_checkRateLimit(callerKey) {
		const rpm = this._cfg.rpm;
		if (!rpm) {
			return true;
		}
		const now = this._now();
		const windowStart = now - 60000;
		const bucket = this._rate.get(callerKey) || [];
		const next = bucket.filter(ts => typeof ts === 'number' && ts >= windowStart);
		if (next.length >= rpm) {
			this._rate.set(callerKey, next);
			return false;
		}
		next.push(now);
		this._rate.set(callerKey, next);
		return true;
	}

	/**
	 * @param {string} key Cache key.
	 * @returns {any|null} Cached AiResult or null.
	 */
	_cacheGet(key) {
		const entry = this._cache.get(key);
		if (!entry) {
			return null;
		}
		const now = this._now();
		if (entry.expiresAt <= now) {
			this._cache.delete(key);
			return null;
		}
		const res = entry.result;
		if (!res || typeof res !== 'object') {
			return res;
		}
		const meta = res.meta && typeof res.meta === 'object' ? res.meta : {};
		return { ...res, meta: { ...meta, cached: true } };
	}

	/**
	 * @param {string} key Cache key.
	 * @param {any} result AiResult to cache.
	 * @param {number} ttlMs TTL in ms.
	 * @returns {void}
	 */
	_cacheSet(key, result, ttlMs) {
		const now = this._now();
		this._cache.set(key, { expiresAt: now + ttlMs, result: isObject(result) ? { ...result } : result });
	}

	/**
	 * @param {any} list Raw override list.
	 * @returns {ReadonlyArray<{ purpose: string, quality: ('fast'|'balanced'|'best')|null, model: string }>} Normalized list.
	 */
	_normalizePurposeModelOverrides(list) {
		if (!Array.isArray(list)) {
			return Object.freeze([]);
		}
		const out = [];
		for (const row of list) {
			const purpose = typeof row?.purpose === 'string' ? row.purpose.trim().toLowerCase() : '';
			const model = typeof row?.model === 'string' ? row.model.trim() : '';
			if (!purpose || !model) {
				continue;
			}
			const rawQ = typeof row?.quality === 'string' ? row.quality.trim().toLowerCase() : '';
			const quality = rawQ ? normalizeQuality(rawQ) : null;
			out.push(Object.freeze({ purpose, quality, model }));
		}
		return Object.freeze(out);
	}

	/**
	 * @param {{ purpose: string, quality: string }} options Options.
	 * @returns {string} Resolved model name.
	 */
	_resolveModel({ purpose, quality }) {
		const p = typeof purpose === 'string' ? purpose.trim().toLowerCase() : '';
		const q = normalizeQuality(quality);

		const overrides = this._cfg.openai.purposeModelOverrides;
		if (p && overrides.length) {
			const exact = overrides.find(o => o.purpose === p && o.quality === q);
			if (exact?.model) {
				return exact.model;
			}
			const any = overrides.find(o => o.purpose === p && o.quality == null);
			if (any?.model) {
				return any.model;
			}
		}

		const byQuality = this._cfg.openai.modelsByQuality;
		return byQuality?.[q] || this._cfg.openai.defaultModel;
	}

	/**
	 * @param {object} options Call options.
	 * @param {string} options.purpose Purpose label.
	 * @param {any[]} options.messages Provider messages.
	 * @param {string} options.model Resolved model.
	 * @param {'fast'|'balanced'|'best'} options.quality Normalized quality.
	 * @param {number|undefined} options.temperature Temperature.
	 * @param {number|null} options.maxTokens Max tokens (nullable).
	 * @param {boolean} options.jsonMode When true, request JSON object output.
	 * @param {number} options.timeoutMs Timeout in ms.
	 * @returns {Promise<any>} AiResult.
	 */
	async _openAiChatCompletions({ purpose, messages, model, quality, temperature, maxTokens, jsonMode, timeoutMs }) {
		const { apiKey, baseUrl } = this._cfg.openai;
		const resolvedModel = typeof model === 'string' && model.trim() ? model.trim() : this._cfg.openai.defaultModel;
		const url = `${baseUrl}/chat/completions`;

		const payload = {
			model: resolvedModel,
			messages: messages.map(m => ({
				role: typeof m?.role === 'string' ? m.role : 'user',
				content: typeof m?.content === 'string' ? m.content : '',
			})),
			...(temperature !== undefined ? { temperature } : {}),
			...(maxTokens !== null ? { max_tokens: maxTokens } : {}),
			...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
		};

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);

		try {
			const res = await this._fetch(url, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${apiKey}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify(payload),
				signal: controller.signal,
			});

			const text = await res.text();
			let json;
			try {
				json = text ? JSON.parse(text) : null;
			} catch {
				json = null;
			}

			if (!res.ok) {
				const msg =
					typeof json?.error?.message === 'string'
						? json.error.message
						: typeof text === 'string' && text.trim()
							? text.trim()
							: `HTTP ${res.status}`;

				return {
					ok: false,
					error: { code: 'PROVIDER_ERROR', message: msg },
					meta: {
						provider: 'openai',
						endpoint: 'chat.completions',
						purpose,
						quality,
						model: resolvedModel,
						status: res.status,
					},
				};
			}

			const content = json?.choices?.[0]?.message?.content;
			if (typeof content !== 'string') {
				return {
					ok: false,
					error: { code: 'PROVIDER_ERROR', message: 'missing content' },
					meta: { provider: 'openai', endpoint: 'chat.completions', purpose, quality, model: resolvedModel },
				};
			}

			if (!jsonMode) {
				return {
					ok: true,
					value: content,
					meta: { provider: 'openai', endpoint: 'chat.completions', purpose, quality, model: resolvedModel },
				};
			}

			try {
				return {
					ok: true,
					value: JSON.parse(content),
					meta: { provider: 'openai', endpoint: 'chat.completions', purpose, quality, model: resolvedModel },
				};
			} catch (e) {
				return {
					ok: false,
					error: { code: 'BAD_JSON', message: String(e?.message || e) },
					meta: { provider: 'openai', endpoint: 'chat.completions', purpose, quality, model: resolvedModel },
				};
			}
		} catch (e) {
			const isAbort = e?.name === 'AbortError';
			return {
				ok: false,
				error: { code: isAbort ? 'TIMEOUT' : 'PROVIDER_ERROR', message: String(e?.message || e) },
				meta: { provider: 'openai', endpoint: 'chat.completions', purpose, quality, model: resolvedModel },
			};
		} finally {
			clearTimeout(timeout);
		}
	}
}

module.exports = { MsgAi };
