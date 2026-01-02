'use strict';

const { expect } = require('chai');
const { MsgAi } = require('./MsgAi');

function makeFetchStub({ content, status = 200, ok = true, onRequest } = {}) {
	let calls = 0;
	const fetch = async (_url, options) => {
		calls += 1;
		onRequest?.(options);
		return {
			ok,
			status,
			text: async () =>
				JSON.stringify({
					choices: [{ message: { content } }],
				}),
		};
	};
	return { fetch, getCalls: () => calls };
}

describe('MsgAi', () => {
	it('selects model by hints.quality and includes it in meta', async () => {
		let usedModel = null;
		const { fetch } = makeFetchStub({
			content: 'ok',
			onRequest: options => {
				const body = JSON.parse(options.body);
				usedModel = body.model;
			},
		});

		const msgAi = new MsgAi(null, {
			enabled: true,
			provider: 'openai',
			openai: {
				apiKey: 'k',
				baseUrl: 'https://example.invalid/v1',
				model: 'fallback',
				modelsByQuality: { fast: 'm-fast', balanced: 'm-balanced', best: 'm-best' },
			},
			fetch,
		});

		const api = msgAi.createCallerApi({ regId: 'NotifyX:0' });
		const res = await api.text({
			purpose: 'ssml',
			messages: [{ role: 'user', content: 'x' }],
			hints: { quality: 'fast' },
		});

		expect(res.ok).to.equal(true);
		expect(usedModel).to.equal('m-fast');
		expect(res.meta).to.have.property('model', 'm-fast');
		expect(res.meta).to.have.property('quality', 'fast');
	});

	it('allows purpose-based model overrides with higher precedence than profile models', async () => {
		let usedModel = null;
		const { fetch } = makeFetchStub({
			content: 'ok',
			onRequest: options => {
				const body = JSON.parse(options.body);
				usedModel = body.model;
			},
		});

		const msgAi = new MsgAi(null, {
			enabled: true,
			provider: 'openai',
			openai: {
				apiKey: 'k',
				baseUrl: 'https://example.invalid/v1',
				model: 'fallback',
				modelsByQuality: { best: 'm-best' },
				purposeModelOverrides: [{ purpose: 'ssml', quality: 'best', model: 'm-ssml' }],
			},
			fetch,
		});

		const api = msgAi.createCallerApi({ regId: 'NotifyX:0' });
		const res = await api.text({
			purpose: 'ssml',
			messages: [{ role: 'user', content: 'x' }],
			hints: { quality: 'best' },
		});

		expect(res.ok).to.equal(true);
		expect(usedModel).to.equal('m-ssml');
		expect(res.meta).to.have.property('model', 'm-ssml');
		expect(res.meta).to.have.property('quality', 'best');
	});

	it('returns BAD_JSON when json() output is invalid JSON', async () => {
		const { fetch } = makeFetchStub({ content: 'not-json' });

		const msgAi = new MsgAi(null, {
			enabled: true,
			provider: 'openai',
			openai: { apiKey: 'k', baseUrl: 'https://example.invalid/v1' },
			fetch,
		});

		const api = msgAi.createCallerApi({ regId: 'IngestX:0' });
		const res = await api.json({
			purpose: 'categorize',
			messages: [{ role: 'user', content: 'x' }],
		});

		expect(res.ok).to.equal(false);
		expect(res.error).to.have.property('code', 'BAD_JSON');
	});

	it('partitions cache by caller regId', async () => {
		const { fetch, getCalls } = makeFetchStub({ content: 'ok' });

		const msgAi = new MsgAi(null, {
			enabled: true,
			provider: 'openai',
			openai: { apiKey: 'k', baseUrl: 'https://example.invalid/v1' },
			cacheTtlMs: 60000,
			fetch,
		});

		const req = {
			purpose: 'ssml',
			messages: [{ role: 'user', content: 'x' }],
			cache: { key: 'k1' },
		};

		const a = msgAi.createCallerApi({ regId: 'P1:0' });
		const b = msgAi.createCallerApi({ regId: 'P2:0' });

		const r1 = await a.text(req);
		const r2 = await a.text(req);
		const r3 = await b.text(req);

		expect(r1.ok).to.equal(true);
		expect(r2.ok).to.equal(true);
		expect(r2.meta).to.have.property('cached', true);
		expect(r3.ok).to.equal(true);

		// First call for P1 + first call for P2 (second call for P1 served from cache)
		expect(getCalls()).to.equal(2);
	});

	it('applies per-plugin RPM limits (caller regId)', async () => {
		const { fetch, getCalls } = makeFetchStub({ content: 'ok' });
		const now = () => 1000;

		const msgAi = new MsgAi(null, {
			enabled: true,
			provider: 'openai',
			openai: { apiKey: 'k', baseUrl: 'https://example.invalid/v1' },
			rpm: 1,
			fetch,
			now,
		});

		const api = msgAi.createCallerApi({ regId: 'P1:0' });
		const req = { purpose: 'ssml', messages: [{ role: 'user', content: 'x' }] };

		const r1 = await api.text(req);
		const r2 = await api.text(req);

		expect(r1.ok).to.equal(true);
		expect(r2.ok).to.equal(false);
		expect(r2.error).to.have.property('code', 'RATE_LIMITED');
		expect(getCalls()).to.equal(1);
	});
});

