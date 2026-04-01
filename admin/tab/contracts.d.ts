export {};

declare global {
	interface DocumentEventMap {
		'msghub:tabSwitch': CustomEvent<{ from?: string; to?: string }>;
	}

	interface Window {
		__msghubAdminTabEntryLoaded?: boolean;
		__msghubAdminTabTheme?: 'dark' | 'light';
		MsghubAdminTabRegistry?: {
			panels?: Record<string, any>;
			compositions?: Record<string, any>;
		};
		[key: string]: any;
	}

	const win: Window & typeof globalThis;
	const io: any;

	const args: any;
	const adapterInstance: string;
	const msghubSocket: any;
	let lang: string;
	const isEmbeddedInAdmin: boolean;
	function overrideLang(newLang: string): void;

	function msghubRequest(command: string, message: any): Promise<any>;
	function h(tag: string, attrs?: any, children?: any): HTMLElement;
	function pickText(value: any): string;

	function ensureAdminI18nLoaded(): Promise<void>;
	function hasAdminKey(key: string): boolean;
	function mergePluginI18n(pluginType: string, translations: Record<string, unknown>): void;
	function t(key: string, ...args: any[]): string;
	function readThemeFromTopWindow(): 'dark' | 'light' | null;
	function applyTheme(nextTheme: 'dark' | 'light'): void;
	function detectTheme(): 'dark' | 'light';
	const urlThemeLocked: boolean;

	function computeContextMenuPosition(params: any): { x: number; y: number };
	function toContextMenuIconVar(iconName: string): string;
	function createAdminApi(deps: any): any;

	function createUi(): any;

	function initTabs(options?: any): { initial: string | null; setActive: (tabId: string) => void };
	function buildLayoutFromRegistry(opts?: { contributions?: any[] }): {
		layout: 'tabs' | 'single';
		panelIds: string[];
		defaultPanelId: string;
		pluginPanelRefs: any[];
	};
	function createMsghubPluginUiHost(opts: { request: any; api: any }): any;
	function resolveViewId(): string;
	function getActiveComposition(): any;
	function computeAssetsForComposition(panelIds: string[]): { css: string[]; js: string[] };
	function loadCssFiles(files: string[]): Promise<{ failed: string[] }>;
	function loadJsFilesSequential(files: string[]): Promise<void>;
	function getPanelDefinition(panelId: string): any;
	function renderPanelBootError(panelId: string, err: any): void;
	/**
	 * Optional PWA / install metadata carried by a panel descriptor.
	 * All text fields are i18n key strings (new contract). Icon paths are package-root-relative
	 * per RFC-0012 — no host-side path assumptions.
	 */
	type AppBlock = {
		/** Required: i18n key string for the installable app name. */
		name: string;
		/** Required: canonical URL for the panel when installed as a PWA. */
		url: string;
		/** Optional: shorter i18n key string; falls back to name when absent. */
		shortName?: string;
		/** Optional: CSS color value for the browser theme-color meta tag. */
		themeColor?: string;
		/** Optional: icon list; paths are package-root-relative (RFC-0012). */
		icons?: Array<{ src: string; sizes?: string; type?: string }>;
	};

	type PanelDescriptorLike = {
		id?: string;
		surface?: 'admin' | 'web' | 'both';
		category?: string;
		/** Optional PWA/install metadata; when present, applyAppHeadMeta manages head meta tags. */
		app?: AppBlock;
		[key: string]: any;
	};

	/**
	 * Minimal shape of a plugin panel contribution returned by `admin.pluginUi.discover`.
	 * The host passes this contribution through `normalizePluginPanel` to build a PanelDescriptor.
	 * Full discover response contract defined in AdminTab_Contracts_APIs.md §6.
	 */
	type PluginContrib = {
		pluginType: string;
		instanceId: number;
		panelId: string;
		/** i18n key string (new contract) or legacy {en, de} object (Altbestand IngestStates). */
		title: any;
		description?: any;
		bundle?: { hash?: string };
		surface?: 'admin' | 'web' | 'both';
		category?: string;
		/** Optional PWA / install metadata; same schema as AppBlock for core panels. */
		app?: AppBlock;
	};

	function activatePanel(panelId: string): string;
	function updateDocumentTitle(descriptor?: PanelDescriptorLike): void;
	function normalizePluginPanel(contrib: PluginContrib, pluginRef: any): PanelDescriptorLike;
	function registerPanelDescriptor(descriptor: PanelDescriptorLike): void;
	function resolvePanelMode(): any;
	function buildSinglePanelShell(descriptor: PanelDescriptorLike): any;
	function renderPanelModeError(errorKey: string): void;
}
