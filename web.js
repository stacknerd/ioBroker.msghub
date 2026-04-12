'use strict';

/**
 * web.js
 * ======
 * Docs: ./docs/ui/web.md
 *
 * Productive MsgHub public-web host loaded by the ioBroker `web` adapter.
 *
 * Responsibilities
 * - Export the class that the ioBroker `web` adapter loads via `common.webExtension`.
 * - Own the public panel-app host under `/MessageHub/<instance>/<panelId>/...`.
 * - Resolve panel apps only through the internal adapter bridge
 *   `sendTo('<msghub.x>', 'internal.uiCatalog.getApp', { mode: 'panel', targetId })`.
 *
 * Non-responsibilities
 * - No local MsgHub runtime/bootstrap in the web adapter.
 * - No local `IoUiCatalog`, `IoPlugins`, or `IoPluginPanelResolver` wiring.
 * - No frontend host-awareness or client-side URL rewriting.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const PRODUCT_MOUNT_SEGMENT = 'MessageHub';
const INTERNAL_GET_APP_COMMAND = 'internal.uiCatalog.getApp';

/**
 * Production single-webapp host for MsgHub panel apps.
 */
class IoWebExtension {
	/**
	 * @param {object} [options] Optional runtime dependencies and paths.
	 * @param {{ _id?: string }|null} [options.instanceObject] Current MsgHub instance object.
	 * @param {{ warn?: Function, error?: Function }|null} [options.log] Optional logger.
	 * @param {string} [options.mountSegment] Public mount segment. Defaults to `MessageHub`.
	 * @param {(instance: string, command: string, message: any, callback: (result: any) => void) => void} [options.sendTo]
	 *   ioBroker web-adapter `sendTo(...)` function used for the internal bridge.
	 * @param {string} [options.sendToTarget] Explicit MsgHub adapter namespace override.
	 * @param {(request: { mode: 'panel', targetId: string }) => Promise<object|null>|object|null} [options.getApp]
	 *   Optional direct app resolver override, primarily for tests.
	 * @param {string} [options.repoRoot] Repository root path.
	 * @param {string} [options.adminRoot] Admin asset root path.
	 * @param {string} [options.tabHtmlPath] Physical path to `admin/tab.html`.
	 * @param {(filePath: string, encoding?: BufferEncoding) => Promise<any>} [options.readFile]
	 *   Optional file-reader override used by tests.
	 */
	constructor({
		instanceObject = null,
		log = null,
		mountSegment = PRODUCT_MOUNT_SEGMENT,
		sendTo = undefined,
		sendToTarget = '',
		getApp = undefined,
		repoRoot = path.resolve(__dirname),
		adminRoot = path.resolve(__dirname, 'admin'),
		tabHtmlPath = path.resolve(__dirname, 'admin', 'tab.html'),
		readFile = undefined,
	} = {}) {
		this.instanceObject = instanceObject && typeof instanceObject === 'object' ? instanceObject : null;
		this.log = log && typeof log === 'object' ? log : null;
		this.mountSegment = this._normalizeMountSegment(mountSegment);
		this.repoRoot = path.resolve(String(repoRoot || path.resolve(__dirname)));
		this.adminRoot = path.resolve(String(adminRoot || path.resolve(this.repoRoot, 'admin')));
		this.tabHtmlPath = path.resolve(String(tabHtmlPath || path.resolve(this.adminRoot, 'tab.html')));
		this.readFile = typeof readFile === 'function' ? readFile : fs.readFile.bind(fs);
		this.instanceId = this._resolveInstanceId(this.instanceObject);
		this.adapterNamespace = this._resolveAdapterNamespace(this.instanceObject);
		this.routePath = this.instanceId === null ? null : `/${this.mountSegment}/${this.instanceId}`;
		this._bridgeSendTo = typeof sendTo === 'function' ? sendTo : null;
		this._bridgeTarget =
			typeof sendToTarget === 'string' && sendToTarget.trim() ? sendToTarget.trim() : this.adapterNamespace;
		this.getApp = this._resolveGetApp({ getApp, sendTo, sendToTarget });
		this._app = null;
		this._middleware = null;
	}

	/**
	 * Resolve the canonical public mount segment.
	 *
	 * @param {any} mountSegment Candidate mount segment.
	 * @returns {string} Trimmed mount segment without slashes.
	 */
	_normalizeMountSegment(mountSegment) {
		const raw = typeof mountSegment === 'string' ? mountSegment.trim() : '';
		const normalized = raw.replace(/^\/+|\/+$/g, '');
		return normalized || PRODUCT_MOUNT_SEGMENT;
	}

	/**
	 * Resolve the adapter instance id from the current ioBroker object id.
	 *
	 * @param {{ _id?: string }|null} instanceObject Candidate instance object.
	 * @returns {number|null} Numeric instance id, or null when unresolved.
	 */
	_resolveInstanceId(instanceObject) {
		const objectId = typeof instanceObject?._id === 'string' ? instanceObject._id.trim() : '';
		const match = objectId.match(/^system\.adapter\.[^.]+\.(\d+)$/);
		if (!match) {
			return null;
		}
		return Number.parseInt(match[1], 10);
	}

	/**
	 * Resolve the MsgHub adapter namespace from the current ioBroker object id.
	 *
	 * @param {{ _id?: string }|null} instanceObject Candidate instance object.
	 * @returns {string|null} Adapter namespace such as `msghub.0`, or null.
	 */
	_resolveAdapterNamespace(instanceObject) {
		const objectId = typeof instanceObject?._id === 'string' ? instanceObject._id.trim() : '';
		const match = objectId.match(/^system\.adapter\.(.+)$/);
		const namespace = match?.[1] ? String(match[1]).trim() : '';
		return namespace || null;
	}

	/**
	 * Resolve the strict panel-app gateway used by this host.
	 *
	 * @param {{ getApp?: Function|object|null, sendTo?: Function|null, sendToTarget?: string }} options Dependency candidates.
	 * @returns {(request: { mode: 'panel', targetId: string }) => Promise<object|null>} Async app resolver.
	 */
	_resolveGetApp({ getApp = null, sendTo = null, sendToTarget = '' } = {}) {
		if (typeof getApp === 'function') {
			return async request => await getApp(request);
		}

		const target =
			typeof sendToTarget === 'string' && sendToTarget.trim() ? sendToTarget.trim() : this.adapterNamespace;
		if (typeof sendTo !== 'function' || !target) {
			return async () => null;
		}

		return async request => await this._resolveAppViaBridge({ sendTo, target, request });
	}

	/**
	 * Resolve one panel app through the internal adapter bridge.
	 *
	 * @param {{ sendTo: Function, target: string, request: { mode: 'panel', targetId: string } }} options Bridge inputs.
	 * @returns {Promise<object|null>} Resolved app record or null.
	 */
	async _resolveAppViaBridge({ sendTo, target, request }) {
		const result = await this._callInternalBridge({
			sendTo,
			target,
			command: INTERNAL_GET_APP_COMMAND,
			message: request,
		});
		return this._normalizeBridgeAppResult(result);
	}

	/**
	 * Execute one internal adapter bridge call.
	 *
	 * @param {{ sendTo?: Function|null, target?: string|null, command: string, message: any }} options Bridge inputs.
	 * @returns {Promise<any>} Raw bridge result.
	 */
	async _callInternalBridge({ sendTo = this._bridgeSendTo, target = this._bridgeTarget, command, message }) {
		if (typeof sendTo !== 'function' || !target) {
			return null;
		}
		return await new Promise(resolve => {
			try {
				sendTo(target, command, message, resolve);
			} catch (error) {
				this.log?.error?.(`IoWebExtension: ${command} bridge failed: ${error?.message || error}`);
				resolve({ ok: false, error: { code: 'INTERNAL', message: String(error?.message || error) } });
			}
		});
	}

	/**
	 * Normalize the bridge callback result to the expected host shape.
	 *
	 * @param {any} result Bridge callback payload.
	 * @returns {object|null} App record or null.
	 */
	_normalizeBridgeAppResult(result) {
		if (result == null) {
			return null;
		}
		if (result && typeof result === 'object' && result.ok === false && result.error) {
			const code = typeof result.error?.code === 'string' ? result.error.code : 'INTERNAL';
			this.log?.warn?.(`IoWebExtension: ${INTERNAL_GET_APP_COMMAND} returned ${code}`);
			return null;
		}
		return result && typeof result === 'object' ? result : null;
	}

	/**
	 * Attach the web-extension middleware to the web adapter's express app.
	 *
	 * @param {{ use?: Function }} app Express app owned by `iobroker.web`.
	 * @returns {boolean} True when middleware registration succeeded.
	 */
	attach(app) {
		if (!app || typeof app.use !== 'function') {
			throw new Error('IoWebExtension: express app is required');
		}
		if (this.instanceId === null || !this.routePath) {
			this.log?.warn?.('IoWebExtension: could not resolve instance id, extension route not registered');
			return false;
		}
		if (this._app && this._middleware) {
			return true;
		}

		this._app = app;
		this._middleware = (req, res, next) => {
			void this._handleMiddleware(req, res, next);
		};
		app.use(this._middleware);
		return true;
	}

	/**
	 * Remove the previously registered middleware from the express stack.
	 *
	 * @returns {boolean} True when a registered middleware was removed.
	 */
	detach() {
		if (!this._app || !this._middleware) {
			return false;
		}

		const appObject = Object(this._app);
		const stack = Array.isArray(appObject._router?.stack)
			? appObject._router.stack
			: Array.isArray(appObject.router?.stack)
				? appObject.router.stack
				: null;
		if (Array.isArray(stack)) {
			const middlewareIndex = stack.findIndex(layer => layer?.handle === this._middleware);
			if (middlewareIndex !== -1) {
				stack.splice(middlewareIndex, 1);
			}
		}

		this._app = null;
		this._middleware = null;
		return true;
	}

	/**
	 * Handle one express middleware call.
	 *
	 * @param {any} req Express request.
	 * @param {any} res Express response.
	 * @param {Function|undefined} next Express next callback.
	 * @returns {Promise<void>} Settles after the request was handled or delegated.
	 */
	async _handleMiddleware(req, res, next) {
		try {
			if (!this._isSupportedMethod(req?.method)) {
				if (typeof next === 'function') {
					next();
				}
				return;
			}

			const request = this._parseRequest(req);
			if (!request.managed) {
				if (typeof next === 'function') {
					next();
				}
				return;
			}

			if (request.kind === 'root' || request.kind === 'blocked' || request.kind === 'invalid') {
				await this._sendNotFound(req, res);
				return;
			}

			if (request.kind === 'iconAssetRoot') {
				await this._serveHostIconAsset(req, res, request);
				return;
			}

			if (typeof request.panelId !== 'string' || !request.panelId) {
				await this._sendNotFound(req, res);
				return;
			}

			const appRecord = await this._resolvePanelApp(request.panelId);
			if (!appRecord) {
				await this._sendNotFound(req, res);
				return;
			}

			if (request.kind === 'panelRedirect') {
				await this._redirectToSlash(req, res, request);
				return;
			}
			if (request.kind === 'panelHtml') {
				await this._servePanelHtml(req, res, request, appRecord);
				return;
			}
			if (request.kind === 'iconAsset') {
				await this._serveIcon(req, res, request, appRecord);
				return;
			}
			if (request.kind === 'adminAsset') {
				await this._serveAdminAsset(req, res, request);
				return;
			}

			await this._sendNotFound(req, res);
		} catch (error) {
			if (error?.code === 'BAD_REQUEST') {
				await this._sendNotFound(req, res);
				return;
			}
			this.log?.error?.(`IoWebExtension: request handling failed: ${error?.message || error}`);
			if (typeof next === 'function') {
				next(error);
				return;
			}
			await this._sendInternalError(req, res);
		}
	}

	/**
	 * Serve one host-root icon asset under `/MessageHub/<instance>/icons/...`.
	 *
	 * @param {any} req Express request.
	 * @param {any} res Express response.
	 * @param {{ assetSegments?: string[] }} request Parsed request descriptor.
	 * @returns {Promise<void>} Settles once the response was written.
	 */
	async _serveHostIconAsset(req, res, request) {
		const requestedIconPath = this._toHostRelativeAssetPath(request.assetSegments || []);
		const filePath = this._resolveHostIconAssetPath(requestedIconPath);
		if (!filePath) {
			await this._sendNotFound(req, res);
			return;
		}
		await this._serveFile(req, res, filePath, { contentType: this._detectContentType(filePath) });
	}

	/**
	 * Return whether the request method is handled by the web host.
	 *
	 * @param {any} method Candidate HTTP method.
	 * @returns {boolean} True for GET and HEAD.
	 */
	_isSupportedMethod(method) {
		const normalized = typeof method === 'string' ? method.trim().toUpperCase() : 'GET';
		return normalized === 'GET' || normalized === 'HEAD';
	}

	/**
	 * Parse one incoming request against the canonical public host contract.
	 *
	 * @param {any} req Express request.
	 * @returns {{
	 *   managed: boolean,
	 *   kind?: 'root'|'blocked'|'invalid'|'panelRedirect'|'panelHtml'|'iconAsset'|'iconAssetRoot'|'adminAsset',
	 *   panelId?: string,
	 *   pathname?: string,
	 *   search?: string,
	 *   assetSegments?: string[],
	 *   publicPanelPath?: string
	 * }} Parsed request descriptor.
	 */
	_parseRequest(req) {
		const parsedUrl = this._parseRawUrl(req);
		const pathname = parsedUrl.pathname;
		const search = parsedUrl.search;
		if (!this.routePath) {
			return { managed: false };
		}
		if (pathname !== this.routePath && !pathname.startsWith(`${this.routePath}/`)) {
			return { managed: false };
		}

		const remainder = pathname.slice(this.routePath.length);
		if (!remainder || remainder === '/') {
			return { managed: true, kind: 'root', pathname, search };
		}
		if (remainder === '/tab.html') {
			return { managed: true, kind: 'blocked', pathname, search };
		}

		const encodedSegments = remainder.replace(/^\/+/, '').split('/').filter(Boolean);
		if (encodedSegments.length === 0) {
			return { managed: true, kind: 'root', pathname, search };
		}

		let segments;
		try {
			segments = encodedSegments.map(segment => this._decodePathSegment(segment));
		} catch {
			return { managed: true, kind: 'invalid', pathname, search };
		}

		if (segments[0] === 'icons') {
			const assetSegments = segments;
			if (assetSegments.length < 2 || this._hasUnsafePathSegments(assetSegments)) {
				return { managed: true, kind: 'invalid', pathname, search };
			}
			return {
				managed: true,
				kind: 'iconAssetRoot',
				pathname,
				search,
				assetSegments,
			};
		}

		const panelId = segments[0];
		if (!panelId || panelId === 'tab.html' || this._hasUnsafePathSegments([panelId])) {
			return { managed: true, kind: 'invalid', pathname, search };
		}

		const subSegments = segments.slice(1);
		const publicPanelPath = `${this.routePath}/${encodeURIComponent(panelId)}/`;
		if (subSegments.length === 0) {
			return {
				managed: true,
				kind: pathname.endsWith('/') ? 'panelHtml' : 'panelRedirect',
				panelId,
				pathname,
				search,
				publicPanelPath,
			};
		}
		if (subSegments[0] === 'icons') {
			return { managed: true, kind: 'blocked', pathname, search, panelId, publicPanelPath };
		}
		if (subSegments[0] === 'admin') {
			const assetSegments = subSegments.slice(1);
			if (assetSegments.length === 0 || this._hasUnsafePathSegments(assetSegments)) {
				return { managed: true, kind: 'invalid', pathname, search };
			}
			return {
				managed: true,
				kind: 'adminAsset',
				panelId,
				pathname,
				search,
				assetSegments,
				publicPanelPath,
			};
		}

		return { managed: true, kind: 'blocked', pathname, search, panelId, publicPanelPath };
	}

	/**
	 * Parse the raw request URL into pathname and search components.
	 *
	 * @param {any} req Express request.
	 * @returns {{ pathname: string, search: string }} Parsed URL parts.
	 */
	_parseRawUrl(req) {
		const rawUrl =
			typeof req?.originalUrl === 'string' && req.originalUrl
				? req.originalUrl
				: typeof req?.url === 'string' && req.url
					? req.url
					: '/';
		const parsed = new URL(rawUrl, 'http://localhost');
		return {
			pathname: parsed.pathname,
			search: parsed.search || '',
		};
	}

	/**
	 * Decode one URL path segment defensively.
	 *
	 * @param {string} segment Encoded path segment.
	 * @returns {string} Decoded segment.
	 */
	_decodePathSegment(segment) {
		return decodeURIComponent(String(segment || ''));
	}

	/**
	 * Return whether the path contains traversal or empty-segment input.
	 *
	 * @param {string[]} segments Candidate decoded path segments.
	 * @returns {boolean} True when the path is unsafe.
	 */
	_hasUnsafePathSegments(segments) {
		return segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('/'));
	}

	/**
	 * Resolve the canonical panel app through the single allowed gateway.
	 *
	 * @param {string} panelId Public panel id from the request path.
	 * @returns {Promise<object|null>} Resolved app record or null.
	 */
	async _resolvePanelApp(panelId) {
		const rawPanelId = typeof panelId === 'string' ? panelId.trim() : '';
		if (!rawPanelId) {
			return null;
		}
		return await this.getApp({
			mode: 'panel',
			targetId: `tab-${rawPanelId}`,
		});
	}

	/**
	 * Redirect the slashless public panel route to the trailing-slash form.
	 *
	 * @param {any} req Express request.
	 * @param {any} res Express response.
	 * @param {{ publicPanelPath?: string, search?: string }} request Parsed request descriptor.
	 * @returns {Promise<void>} Settles once the redirect was written.
	 */
	async _redirectToSlash(req, res, request) {
		const location = `${request.publicPanelPath || `${this.routePath}/`}${request.search || ''}`;
		if (typeof res?.redirect === 'function') {
			res.redirect(301, location);
			return;
		}
		await this._sendResponse(req, res, {
			status: 301,
			headers: { Location: location },
			body: '',
		});
	}

	/**
	 * Serve the transformed AdminTab shell for one public panel route.
	 *
	 * @param {any} req Express request.
	 * @param {any} res Express response.
	 * @param {{ panelId?: string, publicPanelPath?: string }} request Parsed request descriptor.
	 * @param {object} appRecord Resolved panel app record.
	 * @returns {Promise<void>} Settles once the response was written.
	 */
	async _servePanelHtml(req, res, request, appRecord) {
		const source = await this.readFile(this.tabHtmlPath, 'utf8');
		const body = this._transformShellHtml(source, {
			panelId: request.panelId || '',
			publicPanelPath: request.publicPanelPath || `${this.routePath}/`,
		});
		void appRecord;
		await this._sendResponse(req, res, {
			status: 200,
			contentType: 'text/html; charset=utf-8',
			body,
		});
	}

	/**
	 * Transform `admin/tab.html` into the public single-webapp shell.
	 *
	 * @param {string} html Raw `admin/tab.html` content.
	 * @param {{ panelId: string, publicPanelPath: string }} options Transform inputs.
	 * @returns {string} Transformed HTML.
	 */
	_transformShellHtml(html, { panelId, publicPanelPath }) {
		const source = String(html || '');
		const baseHref = this._escapeHtmlAttribute(`${publicPanelPath}admin/`);
		const forwardedArgs = this._escapeHtmlText(
			JSON.stringify({
				instance: String(this.instanceId),
				panel: `tab-${panelId}`,
				composition: 'adminTab',
			}),
		);

		const headLines = [
			`<base href="${baseHref}" />`,
			`<script id="msghub-forwarded-args" type="application/json">${forwardedArgs}</script>`,
		].filter(Boolean);

		let transformed = source.replace(
			/<script\s+src="\.\.\/\.\.\/lib\/js\/socket\.io\.js"><\/script>/,
			'<script src="/lib/js/socket.io.js"></script>',
		);
		if (/<head>/i.test(transformed)) {
			transformed = transformed.replace(/<head>/i, `<head>\n\t${headLines.join('\n\t')}`);
		} else {
			transformed = `${headLines.join('\n')}\n${transformed}`;
		}
		return transformed;
	}

	/**
	 * Serve one host-relative app icon asset through the public route.
	 *
	 * @param {any} req Express request.
	 * @param {any} res Express response.
	 * @param {{ assetSegments?: string[] }} request Parsed request descriptor.
	 * @param {object} appRecord Resolved panel app record.
	 * @returns {Promise<void>} Settles once the icon response was written.
	 */
	async _serveIcon(req, res, request, appRecord) {
		const requestedIconPath = this._toHostRelativeAssetPath(request.assetSegments || []);
		const filePath = this._resolvePublicIconAssetPath(requestedIconPath, appRecord);
		if (!filePath) {
			await this._sendNotFound(req, res);
			return;
		}
		await this._serveFile(req, res, filePath, { contentType: this._detectContentType(filePath) });
	}

	/**
	 * Resolve one requested public icon asset path to a physical file path.
	 *
	 * Only icon paths explicitly exposed through `resolvedAppIcons` are served.
	 *
	 * @param {string} iconPath Host-relative icon path from the public request.
	 * @param {object} appRecord Resolved panel app record.
	 * @returns {string|null} Safe absolute file path or null.
	 */
	_resolvePublicIconAssetPath(iconPath, appRecord) {
		const raw = typeof iconPath === 'string' ? iconPath.trim() : '';
		if (!raw.startsWith('icons/')) {
			return null;
		}
		const allowedIconPaths = Object.values(appRecord?.resolvedAppIcons || {})
			.filter(value => typeof value === 'string')
			.map(value => value.trim())
			.filter(Boolean);
		if (!allowedIconPaths.includes(raw)) {
			return null;
		}
		return this._resolveAdminRelativePath(raw.split('/').filter(Boolean));
	}

	/**
	 * Resolve one host-root icon asset path to a physical file path.
	 *
	 * @param {string} iconPath Host-relative icon path from the public request.
	 * @returns {string|null} Safe absolute file path or null.
	 */
	_resolveHostIconAssetPath(iconPath) {
		const raw = typeof iconPath === 'string' ? iconPath.trim() : '';
		if (!raw.startsWith('icons/')) {
			return null;
		}
		return this._resolveAdminRelativePath(raw.split('/').filter(Boolean));
	}

	/**
	 * Serve one host-owned admin asset inside the allowed public asset cut.
	 *
	 * @param {any} req Express request.
	 * @param {any} res Express response.
	 * @param {{ assetSegments?: string[] }} request Parsed request descriptor.
	 * @returns {Promise<void>} Settles once the response was written.
	 */
	async _serveAdminAsset(req, res, request) {
		const filePath = this._resolveAllowedAdminAssetPath(request.assetSegments || []);
		if (!filePath) {
			await this._sendNotFound(req, res);
			return;
		}
		await this._serveFile(req, res, filePath, { contentType: this._detectContentType(filePath) });
	}

	/**
	 * Resolve the physical file path for one allowed public admin asset.
	 *
	 * Allowed paths:
	 * - `admin/tab.css`
	 * - `admin/tab.js`
	 * - `admin/tab/**`
	 * - `admin/i18n/**`
	 *
	 * @param {string[]} assetSegments Decoded path segments after `admin/`.
	 * @returns {string|null} Safe file path or null.
	 */
	_resolveAllowedAdminAssetPath(assetSegments) {
		if (!Array.isArray(assetSegments) || assetSegments.length === 0 || this._hasUnsafePathSegments(assetSegments)) {
			return null;
		}

		if (assetSegments.length === 1 && assetSegments[0] === 'tab.css') {
			return path.resolve(this.adminRoot, 'tab.css');
		}
		if (assetSegments.length === 1 && assetSegments[0] === 'tab.js') {
			return path.resolve(this.adminRoot, 'tab.js');
		}
		if (assetSegments[0] === 'tab' && assetSegments.length > 1) {
			return path.resolve(this.adminRoot, 'tab', ...assetSegments.slice(1));
		}
		if (assetSegments[0] === 'i18n' && assetSegments.length > 1) {
			return path.resolve(this.adminRoot, 'i18n', ...assetSegments.slice(1));
		}
		return null;
	}

	/**
	 * Resolve one host-relative admin asset path safely under the checked-in admin root.
	 *
	 * @param {string[]} assetSegments Host-relative asset path segments.
	 * @returns {string|null} Safe absolute path or null.
	 */
	_resolveAdminRelativePath(assetSegments) {
		if (!Array.isArray(assetSegments) || assetSegments.length === 0 || this._hasUnsafePathSegments(assetSegments)) {
			return null;
		}
		const filePath = path.resolve(this.adminRoot, ...assetSegments);
		if (!this._isWithinRoot(filePath, this.adminRoot)) {
			return null;
		}
		return filePath;
	}

	/**
	 * Convert decoded asset segments into one normalized host-relative asset path.
	 *
	 * @param {string[]} assetSegments Decoded asset path segments.
	 * @returns {string} Normalized host-relative asset path.
	 */
	_toHostRelativeAssetPath(assetSegments) {
		if (!Array.isArray(assetSegments) || assetSegments.length === 0) {
			return '';
		}
		return assetSegments
			.map(segment => String(segment || '').trim())
			.filter(Boolean)
			.join('/');
	}

	/**
	 * Return whether one path stays within the given root.
	 *
	 * @param {string} candidatePath Absolute candidate path.
	 * @param {string} rootPath Absolute root path.
	 * @returns {boolean} True when the candidate stays within the root.
	 */
	_isWithinRoot(candidatePath, rootPath) {
		const relative = path.relative(rootPath, candidatePath);
		return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
	}

	/**
	 * Serve one physical file path, mapping missing files to `404`.
	 *
	 * @param {any} req Express request.
	 * @param {any} res Express response.
	 * @param {string} filePath Physical file path.
	 * @param {{ contentType?: string }} [options] Optional response metadata.
	 * @returns {Promise<void>} Settles once the response was written.
	 */
	async _serveFile(req, res, filePath, { contentType = 'application/octet-stream' } = {}) {
		try {
			const body = await this.readFile(filePath);
			await this._sendResponse(req, res, {
				status: 200,
				contentType,
				body,
			});
		} catch (error) {
			if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
				await this._sendNotFound(req, res);
				return;
			}
			throw error;
		}
	}

	/**
	 * Detect the response content type from the file extension.
	 *
	 * @param {string} filePath Physical file path.
	 * @returns {string} Best-effort content type.
	 */
	_detectContentType(filePath) {
		const normalized = String(filePath || '').toLowerCase();
		if (normalized.endsWith('.html')) {
			return 'text/html; charset=utf-8';
		}
		if (normalized.endsWith('.css')) {
			return 'text/css; charset=utf-8';
		}
		if (normalized.endsWith('.js')) {
			return 'application/javascript; charset=utf-8';
		}
		if (normalized.endsWith('.json')) {
			return 'application/json; charset=utf-8';
		}
		if (normalized.endsWith('.webmanifest')) {
			return 'application/manifest+json; charset=utf-8';
		}
		if (normalized.endsWith('.png')) {
			return 'image/png';
		}
		if (normalized.endsWith('.svg')) {
			return 'image/svg+xml';
		}
		if (normalized.endsWith('.webp')) {
			return 'image/webp';
		}
		if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) {
			return 'image/jpeg';
		}
		if (normalized.endsWith('.ico')) {
			return 'image/x-icon';
		}
		return 'application/octet-stream';
	}

	/**
	 * Write one structured response, honoring `HEAD` requests when needed.
	 *
	 * @param {any} req Express request.
	 * @param {any} res Express response.
	 * @param {{ status?: number, contentType?: string, headers?: Record<string, string>, body?: string|Buffer }} payload
	 *   Response payload.
	 * @returns {Promise<void>} Settles once the response was written.
	 */
	async _sendResponse(req, res, { status = 200, contentType = '', headers = {}, body = '' } = {}) {
		for (const [name, value] of Object.entries(headers)) {
			if (typeof res?.setHeader === 'function') {
				res.setHeader(name, value);
			}
		}
		if (contentType && typeof res?.setHeader === 'function') {
			res.setHeader('Content-Type', contentType);
		}
		if (typeof res?.status === 'function') {
			res.status(status);
		} else {
			res.statusCode = status;
		}

		const isHead =
			String(req?.method || 'GET')
				.trim()
				.toUpperCase() === 'HEAD';
		if (isHead) {
			if (typeof res?.send === 'function') {
				res.send('');
				return;
			}
			res.end?.();
			return;
		}

		if (typeof res?.send === 'function') {
			res.send(body);
			return;
		}
		res.end?.(body);
	}

	/**
	 * Send the canonical public `404` response.
	 *
	 * @param {any} req Express request.
	 * @param {any} res Express response.
	 * @returns {Promise<void>} Settles once the response was written.
	 */
	async _sendNotFound(req, res) {
		await this._sendResponse(req, res, {
			status: 404,
			contentType: 'text/plain; charset=utf-8',
			body: 'Not Found',
		});
	}

	/**
	 * Send the canonical public `500` response.
	 *
	 * @param {any} req Express request.
	 * @param {any} res Express response.
	 * @returns {Promise<void>} Settles once the response was written.
	 */
	async _sendInternalError(req, res) {
		await this._sendResponse(req, res, {
			status: 500,
			contentType: 'text/plain; charset=utf-8',
			body: 'Internal Server Error',
		});
	}

	/**
	 * Escape text for HTML element-body insertion.
	 *
	 * @param {string} value Raw text.
	 * @returns {string} Escaped HTML text.
	 */
	_escapeHtmlText(value) {
		return String(value || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}

	/**
	 * Escape text for HTML attribute insertion.
	 *
	 * @param {string} value Raw text.
	 * @returns {string} Escaped attribute text.
	 */
	_escapeHtmlAttribute(value) {
		return this._escapeHtmlText(value).replace(/"/g, '&quot;');
	}
}

/**
 * MsgHub root web-extension entry loaded by the ioBroker `web` adapter.
 */
class WebExtensionEntry {
	/**
	 * @param {any} _server Underlying HTTP(S) server instance provided by `iobroker.web`.
	 * @param {{ secure?: boolean, port?: number, language?: string, defaultUser?: string, auth?: boolean }|null} _settings
	 *   Web-adapter runtime settings (unused by the minimal implementation for now).
	 * @param {{ log?: { info?: Function, warn?: Function, error?: Function, debug?: Function }, sendTo?: Function }|null} webAdapter
	 *   Running `web` adapter instance used for logging and the internal `sendTo(...)` bridge.
	 * @param {{ _id?: string, native?: Record<string, any> }|null} instanceObject
	 *   Current MsgHub instance object that owns this web extension.
	 * @param {{ use?: Function }} app Express application owned by the `web` adapter.
	 */
	constructor(_server, _settings, webAdapter, instanceObject, app) {
		this.readyCallback = null;
		this.isReady = false;

		this.extension = new IoWebExtension({
			instanceObject,
			log: webAdapter?.log || null,
			mountSegment: PRODUCT_MOUNT_SEGMENT,
			sendTo: typeof webAdapter?.sendTo === 'function' ? webAdapter.sendTo.bind(webAdapter) : null,
		});
		this.isReady = this.extension.attach(app);
		this._markReady();
	}

	/**
	 * Optional ioBroker web-extension hook.
	 *
	 * @param {(entry: WebExtensionEntry) => void} cb Ready callback supplied by `iobroker.web`.
	 * @returns {void}
	 */
	waitForReady(cb) {
		if (typeof cb !== 'function') {
			return;
		}
		if (this.isReady) {
			cb(this);
			return;
		}
		this.readyCallback = cb;
	}

	/**
	 * Optional ioBroker web-extension hook.
	 *
	 * @returns {Promise<void>} Settles once teardown is complete.
	 */
	unload() {
		this.extension?.detach?.();
		return Promise.resolve();
	}

	/**
	 * Resolve the deferred ready callback once route installation completed.
	 *
	 * @returns {void}
	 */
	_markReady() {
		if (!this.isReady || typeof this.readyCallback !== 'function') {
			return;
		}
		const callback = this.readyCallback;
		this.readyCallback = null;
		callback(this);
	}
}

module.exports = WebExtensionEntry;
module.exports.web = WebExtensionEntry;
module.exports.IoWebExtension = IoWebExtension;
