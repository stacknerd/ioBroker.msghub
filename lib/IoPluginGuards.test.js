'use strict';

const { expect } = require('chai');

const { isPlainObject, getPath, ensureCtxAvailability } = require('./IoPluginGuards');

describe('IoPluginGuards', () => {
	describe('isPlainObject', () => {
		it('accepts plain objects and rejects null/arrays', () => {
			expect(isPlainObject({})).to.equal(true);
			expect(isPlainObject({ a: 1 })).to.equal(true);
			expect(isPlainObject(null)).to.equal(false);
			expect(isPlainObject([])).to.equal(false);
			expect(isPlainObject('x')).to.equal(false);
		});
	});

	describe('getPath', () => {
		it('resolves dotted paths including optional ctx. prefix', () => {
			const root = { api: { log: { info() {} } } };
			expect(getPath(root, 'api.log')).to.deep.equal(root.api.log);
			expect(getPath(root, 'ctx.api.log')).to.deep.equal(root.api.log);
			expect(getPath(root, 'ctx.api.log.info')).to.equal(root.api.log.info);
		});

		it('returns undefined for invalid paths or missing segments', () => {
			const root = { api: { log: {} } };
			expect(getPath(root, '')).to.equal(undefined);
			expect(getPath(root, null)).to.equal(undefined);
			expect(getPath(root, 'api.nope')).to.equal(undefined);
			expect(getPath(root, 'api.log.info.nope')).to.equal(undefined);
		});
	});

	describe('ensureCtxAvailability', () => {
		it('throws for non-object ctx', () => {
			expect(() => ensureCtxAvailability('T', null)).to.throw(/T: ctx must be a plain object/);
			expect(() => ensureCtxAvailability('T', [])).to.throw(/T: ctx must be a plain object/);
		});

		it('validates plainObject and fn requirements', () => {
			const ctx = { api: { log: { info() {} } }, meta: {} };
			expect(() =>
				ensureCtxAvailability('P', ctx, {
					plainObject: ['api', 'api.log', 'meta'],
					fn: ['api.log.info'],
				}),
			).to.not.throw();

			expect(() =>
				ensureCtxAvailability('P', { api: { log: null } }, { plainObject: ['api.log'] }),
			).to.throw(/P: api\.log must be a plain object/);

			expect(() =>
				ensureCtxAvailability('P', { api: { log: { info: 1 } } }, { fn: ['api.log.info'] }),
			).to.throw(/P: api\.log\.info must be a function/);
		});

		it('validates stringNonEmpty requirements', () => {
			const okCtx = { meta: { plugin: { baseOwnId: 'x' } } };
			expect(() =>
				ensureCtxAvailability('S', okCtx, { stringNonEmpty: ['meta.plugin.baseOwnId'] }),
			).to.not.throw();

			const badCtx = { meta: { plugin: { baseOwnId: ' ' } } };
			expect(() =>
				ensureCtxAvailability('S', badCtx, { stringNonEmpty: ['meta.plugin.baseOwnId'] }),
			).to.throw(/S: meta\.plugin\.baseOwnId must be a non-empty string/);
		});
	});
});

