'use strict';

const { EventEmitter } = require('node:events');
const { expect } = require('chai');

const WebExtensionEntry = require('./web.js');
const { IoWebExtension } = WebExtensionEntry;

const MESSAGES_APP = Object.freeze({
	id: 'messages',
	label: 'msghub.i18n.core.admin.ui.tabs.messages.label',
	category: 'dashboard',
	app: Object.freeze({
		name: 'msghub.i18n.core.admin.panels.messages.app.name',
		shortName: 'msghub.i18n.core.admin.panels.messages.app.shortName',
		url: '?panel=tab-messages',
		display: 'standalone',
		themeColor: '#1f6a53',
		backgroundColor: '#ffffff',
		icons: Object.freeze({
			any192: 'messages-192.png',
			any512: 'messages-512.png',
			maskable192: 'messages-maskable-192.png',
			maskable512: 'messages-maskable-512.png',
			apple180: 'messages-apple-180.png',
		}),
	}),
	resolvedAppIcons: Object.freeze({
		any192: 'icons/messages/messages-192.png',
		any512: 'icons/messages/messages-512.png',
		maskable192: 'icons/messages/messages-maskable-192.png',
		maskable512: 'icons/messages/messages-maskable-512.png',
		apple180: 'icons/messages/messages-apple-180.png',
	}),
});

const PLUGIN_APP = Object.freeze({
	id: 'plugin-IngestStates-0-presets',
	pluginType: 'IngestStates',
	instanceId: 0,
	panelId: 'presets',
	label: 'msghub.i18n.IngestStates.ui.panels.presets.label',
	category: 'user',
	app: Object.freeze({
		name: 'msghub.i18n.IngestStates.ui.panels.presets.app.name',
		shortName: 'msghub.i18n.IngestStates.ui.panels.presets.app.shortName',
		url: '?panel=tab-plugin-IngestStates-0-presets',
		display: 'standalone',
	}),
	resolvedAppIcons: Object.freeze({
		any192: 'icons/pluginUI/pluginUI-192.png',
	}),
});

function createApp() {
	return {
		_router: { stack: [] },
		use(handler) {
			this._router.stack.push({ handle: handler });
		},
	};
}

function createResponse() {
	return {
		headers: {},
		statusCode: null,
		body: null,
		setHeader(name, value) {
			this.headers[name] = value;
		},
		status(code) {
			this.statusCode = code;
			return this;
		},
		send(value) {
			this.body = value;
			return this;
		},
		end(value) {
			if (value !== undefined) {
				this.body = value;
			}
			return this;
		},
		redirect(status, location) {
			this.statusCode = status;
			this.headers.Location = location;
			this.body = '';
		},
	};
}

async function dispatch(
	extension,
	url,
	{ method = 'GET', headers = {}, protocol = 'http', secure = false, body = null } = {},
) {
	const req = new EventEmitter();
	Object.assign(req, {
		method,
		url,
		originalUrl: url,
		headers,
		protocol,
		secure,
		get(name) {
			return this.headers[String(name || '').toLowerCase()] || '';
		},
	});
	const res = createResponse();
	let nextCalled = false;
	let nextError = null;
	const pending = extension._handleMiddleware(req, res, error => {
		nextCalled = true;
		nextError = error || null;
	});
	if (body != null) {
		const chunk = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
		req.emit('data', chunk);
	}
	req.emit('end');
	await pending;
	return { res, nextCalled, nextError };
}

describe('web.js entry', () => {
	it('uses the production MessageHub mount prefix', () => {
		const entry = new WebExtensionEntry(
			null,
			null,
			{ log: null },
			{ _id: 'system.adapter.msghub.0' },
			createApp(),
		);

		expect(entry.extension.routePath).to.equal('/MessageHub/0');
	});

	it('calls waitForReady immediately after synchronous route installation', done => {
		const entry = new WebExtensionEntry(
			null,
			null,
			{ log: null },
			{ _id: 'system.adapter.msghub.0' },
			createApp(),
		);

		entry.waitForReady(instance => {
			expect(instance).to.equal(entry);
			done();
		});
	});

	it('unload removes the installed middleware', async () => {
		const app = createApp();

		const entry = new WebExtensionEntry(null, null, { log: null }, { _id: 'system.adapter.msghub.0' }, app);
		expect(app._router.stack).to.have.length(1);

		await entry.unload();
		expect(app._router.stack).to.have.length(0);
	});

	it('resolves panel apps through the internal uiCatalog bridge', async () => {
		const calls = [];
		const app = createApp();
		const entry = new WebExtensionEntry(
			null,
			null,
			{
				log: null,
				sendTo(target, command, message, callback) {
					calls.push({ target, command, message });
					callback({
						id: 'messages',
						label: 'Messages',
						app: { name: 'Messages', shortName: 'Messages' },
						resolvedAppIcons: {},
					});
				},
			},
			{ _id: 'system.adapter.msghub.0' },
			app,
		);
		entry.extension.readFile = async () =>
			'<html><head></head><body><script src="../../lib/js/socket.io.js"></script><script src="tab/runtime.js"></script></body></html>';

		const { res } = await dispatch(entry.extension, '/MessageHub/0/messages/?theme=light');

		expect(calls).to.deep.equal([
			{
				target: 'msghub.0',
				command: 'internal.uiCatalog.getApp',
				message: { mode: 'panel', targetId: 'tab-messages' },
			},
		]);
		expect(res.statusCode).to.equal(200);
		expect(String(res.body)).to.include('msghub-forwarded-args');
	});
});

describe('IoWebExtension', () => {
	it('derives the production mount path from the adapter instance id', () => {
		const extension = new IoWebExtension({
			instanceObject: { _id: 'system.adapter.msghub.3' },
		});

		expect(extension.instanceId).to.equal(3);
		expect(extension.routePath).to.equal('/MessageHub/3');
	});

	it('registers and detaches one middleware on the express stack', () => {
		const app = createApp();
		const extension = new IoWebExtension({
			instanceObject: { _id: 'system.adapter.msghub.7' },
		});

		expect(extension.attach(app)).to.equal(true);
		expect(app._router.stack).to.have.length(1);
		expect(extension.detach()).to.equal(true);
		expect(app._router.stack).to.have.length(0);
		expect(extension.detach()).to.equal(false);
	});

	it('skips route registration when the instance id cannot be resolved', () => {
		const app = createApp();
		const extension = new IoWebExtension({
			instanceObject: { _id: 'system.adapter.msghub.invalid' },
		});

		expect(extension.attach(app)).to.equal(false);
		expect(app._router.stack).to.deep.equal([]);
	});

	it('passes unrelated requests through to next', async () => {
		const extension = new IoWebExtension({
			instanceObject: { _id: 'system.adapter.msghub.3' },
			getApp: async () => MESSAGES_APP,
		});

		const result = await dispatch(extension, '/somewhere-else');
		expect(result.nextCalled).to.equal(true);
		expect(result.nextError).to.equal(null);
		expect(result.res.statusCode).to.equal(null);
	});

	it('serves the transformed shell and injects canonical forwarded args', async () => {
		const calls = [];
		const extension = new IoWebExtension({
			instanceObject: { _id: 'system.adapter.msghub.3' },
			getApp: async request => {
				calls.push(request);
				return MESSAGES_APP;
			},
		});

		const { res } = await dispatch(
			extension,
			'/MessageHub/3/messages/?theme=light&instance=99&panel=tab-hack&composition=web&lang=de',
		);

		expect(calls).to.deep.equal([{ mode: 'panel', targetId: 'tab-messages' }]);
		expect(res.statusCode).to.equal(200);
		expect(res.headers['Content-Type']).to.equal('text/html; charset=utf-8');
		expect(String(res.body)).to.include('<base href="/MessageHub/3/messages/admin/" />');
		expect(String(res.body)).to.include('<script src="/lib/js/socket.io.js"></script>');
		expect(String(res.body)).to.not.include('rel="manifest"');
		expect(String(res.body)).to.not.include('rel="apple-touch-icon"');
		expect(String(res.body)).to.include(
			'<script id="msghub-forwarded-args" type="application/json">{"instance":"3","panel":"tab-messages","composition":"adminTab","transport":"http"}</script>',
		);
		expect(String(res.body)).to.not.include('__msghubTransport');
		expect(String(res.body)).to.not.include('"tab-hack"');
		expect(String(res.body).indexOf('msghub-forwarded-args')).to.be.lessThan(
			String(res.body).indexOf('<script src="tab/runtime.js"></script>'),
		);
	});

	it('redirects the slashless public panel route to the trailing-slash form', async () => {
		const extension = new IoWebExtension({
			instanceObject: { _id: 'system.adapter.msghub.3' },
			getApp: async () => MESSAGES_APP,
		});

		const { res } = await dispatch(extension, '/MessageHub/3/messages?theme=light&panel=tab-hack');

		expect(res.statusCode).to.equal(301);
		expect(res.headers.Location).to.equal('/MessageHub/3/messages/?theme=light&panel=tab-hack');
	});

	it('returns 404 for the out-of-scope root route and blocked tab.html direct access', async () => {
		const extension = new IoWebExtension({
			instanceObject: { _id: 'system.adapter.msghub.3' },
			getApp: async () => MESSAGES_APP,
		});

		const rootResult = await dispatch(extension, '/MessageHub/3/');
		const tabHtmlResult = await dispatch(extension, '/MessageHub/3/tab.html?panel=tab-messages');

		expect(rootResult.res.statusCode).to.equal(404);
		expect(tabHtmlResult.res.statusCode).to.equal(404);
	});

	it('returns 404 when getApp does not resolve the requested panel app', async () => {
		const calls = [];
		const extension = new IoWebExtension({
			instanceObject: { _id: 'system.adapter.msghub.3' },
			getApp: async request => {
				calls.push(request);
				return null;
			},
		});

		const { res } = await dispatch(extension, '/MessageHub/3/unknown/admin/tab.css');

		expect(calls).to.deep.equal([{ mode: 'panel', targetId: 'tab-unknown' }]);
		expect(res.statusCode).to.equal(404);
	});

	it('does not expose a server-side public manifest route anymore', async () => {
		const extension = new IoWebExtension({
			instanceObject: { _id: 'system.adapter.msghub.3' },
			getApp: async () => MESSAGES_APP,
		});

		const { res } = await dispatch(extension, '/MessageHub/3/messages/manifest.webmanifest?theme=light&lang=de');
		expect(res.statusCode).to.equal(404);
	});

	it('serves host-root icon assets', async () => {
		const extension = new IoWebExtension({
			instanceObject: { _id: 'system.adapter.msghub.3' },
			getApp: async () => MESSAGES_APP,
		});

		const { res } = await dispatch(extension, '/MessageHub/3/icons/messages/messages-192.png');
		expect(res.statusCode).to.equal(200);
		expect(res.headers['Content-Type']).to.equal('image/png');
		expect(Buffer.isBuffer(res.body)).to.equal(true);
		expect(res.body.length).to.be.greaterThan(0);
	});

	it('does not keep legacy panel icon routes as public icon truth', async () => {
		const extension = new IoWebExtension({
			instanceObject: { _id: 'system.adapter.msghub.3' },
			getApp: async () => MESSAGES_APP,
		});

		const { res } = await dispatch(extension, '/MessageHub/3/messages/icons/messages/messages-192.png');
		expect(res.statusCode).to.equal(404);
	});

	it('serves plugin icon assets under the host root', async () => {
		const extension = new IoWebExtension({
			instanceObject: { _id: 'system.adapter.msghub.3' },
			getApp: async () => PLUGIN_APP,
		});

		const okResult = await dispatch(extension, '/MessageHub/3/icons/pluginUI/pluginUI-192.png');
		const blockedResult = await dispatch(extension, '/MessageHub/3/messages/icons/pluginUI/pluginUI-192.png');

		expect(okResult.res.statusCode).to.equal(200);
		expect(blockedResult.res.statusCode).to.equal(404);
	});

	it('serves only the small allowed host-owned admin asset cut', async () => {
		const extension = new IoWebExtension({
			instanceObject: { _id: 'system.adapter.msghub.3' },
			getApp: async () => MESSAGES_APP,
		});

		const cssResult = await dispatch(extension, '/MessageHub/3/messages/admin/tab.css');
		const i18nResult = await dispatch(extension, '/MessageHub/3/messages/admin/i18n/en.json');
		const blockedResult = await dispatch(extension, '/MessageHub/3/messages/admin/icons/messages/messages-192.png');

		expect(cssResult.res.statusCode).to.equal(200);
		expect(cssResult.res.headers['Content-Type']).to.equal('text/css; charset=utf-8');
		expect(Buffer.isBuffer(cssResult.res.body)).to.equal(true);
		expect(i18nResult.res.statusCode).to.equal(200);
		expect(i18nResult.res.headers['Content-Type']).to.equal('application/json; charset=utf-8');
		expect(Buffer.isBuffer(i18nResult.res.body)).to.equal(true);
		expect(blockedResult.res.statusCode).to.equal(404);
	});

	it('serves the HTTP bridge under the host root and filters ui.bootstrap to the web grant', async () => {
		const bridgeCalls = [];
		const extension = new IoWebExtension({
			instanceObject: { _id: 'system.adapter.msghub.3' },
			sendTo(target, command, message, callback) {
				bridgeCalls.push({ target, command, message });
				callback({
					ok: true,
					data: {
						capabilities: {
							admin: { token: 'admin-token', expiresAt: '2999-01-01T00:00:00.000Z' },
							config: { token: 'config-token', expiresAt: '2999-01-01T00:00:00.000Z' },
							web: { token: 'web-token', expiresAt: '2999-01-01T00:00:00.000Z' },
						},
						about: { title: 'Message Hub' },
					},
				});
			},
		});

		const { res } = await dispatch(extension, '/MessageHub/3/query', {
			method: 'POST',
			body: JSON.stringify({ cmd: 'ui.bootstrap', payload: {} }),
		});

		expect(bridgeCalls).to.deep.equal([
			{ target: 'msghub.3', command: 'ui.bootstrap', message: { host: 'webExtension' } },
		]);
		expect(res.statusCode).to.equal(200);
		expect(JSON.parse(String(res.body))).to.deep.equal({
			ok: true,
			data: {
				capabilities: {
					web: { token: 'web-token', expiresAt: '2999-01-01T00:00:00.000Z' },
				},
				about: { title: 'Message Hub' },
			},
		});
	});

	it('rejects invalid JSON and forbidden bridge commands', async () => {
		const extension = new IoWebExtension({
			instanceObject: { _id: 'system.adapter.msghub.3' },
			sendTo() {
				throw new Error('sendTo must not be called');
			},
		});

		const invalidJson = await dispatch(extension, '/MessageHub/3/query', {
			method: 'POST',
			body: '{bad json',
		});
		const forbidden = await dispatch(extension, '/MessageHub/3/query', {
			method: 'POST',
			body: JSON.stringify({ cmd: 'admin.stats.get', payload: {} }),
		});

		expect(invalidJson.res.statusCode).to.equal(400);
		expect(JSON.parse(String(invalidJson.res.body))).to.deep.equal({
			ok: false,
			error: { code: 'BAD_REQUEST', message: 'Invalid JSON payload' },
		});
		expect(forbidden.res.statusCode).to.equal(403);
		expect(JSON.parse(String(forbidden.res.body))).to.deep.equal({
			ok: false,
			error: { code: 'FORBIDDEN', message: 'Command not allowed' },
		});
	});

	it('overrides any client-supplied bridge host hint with webExtension server-side', async () => {
		const bridgeCalls = [];
		const extension = new IoWebExtension({
			instanceObject: { _id: 'system.adapter.msghub.3' },
			sendTo(target, command, message, callback) {
				bridgeCalls.push({ target, command, message });
				callback({ ok: true, data: 'pong' });
			},
		});

		const { res } = await dispatch(extension, '/MessageHub/3/query', {
			method: 'POST',
			body: JSON.stringify({ cmd: 'web.ping', payload: { host: 'admin', token: 'x' } }),
		});

		expect(bridgeCalls).to.deep.equal([
			{
				target: 'msghub.3',
				command: 'web.ping',
				message: { host: 'webExtension', token: 'x' },
			},
		]);
		expect(JSON.parse(String(res.body))).to.deep.equal({ ok: true, data: 'pong' });
	});
});
