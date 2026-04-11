export {};

declare global {
	interface DocumentEventMap {
		'msghub:tabSwitch': CustomEvent<{ from?: string; to?: string }>;
	}

	interface Window {
		__msghubAdminTabEntryLoaded?: boolean;
		__msghubAdminTabTheme?: 'dark' | 'light';
		[key: string]: any;
	}

	interface HTMLScriptElement {
		__msghubCorePanelEntry?: CorePanelEntry;
	}

	interface SVGScriptElement {
		__msghubCorePanelEntry?: CorePanelEntry;
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
	function buildLayoutFromRegistry(): {
		layout: 'tabs' | 'single';
		panelIds: string[];
		defaultPanelId: string;
		pluginPanelRefs: PluginPanelRef[];
		missingNativePanelIds: string[];
	};
	function createMsghubPluginUiHost(opts: { request: any; api: any }): any;
	function resolveViewRequest(): { mode: 'composition' | 'panel'; targetId?: string };
	function setActiveView(view: AdminTabViewResponse | null | undefined): AdminTabViewResponse | null;
	function getActiveView(): AdminTabViewResponse | null;
	function resolveViewId(): string | null;
	function getActiveComposition(): any;
	function loadCssFiles(files: string[]): Promise<{ failed: string[] }>;
	function loadJsFilesSequential(files: string[]): Promise<void>;
	type CorePanelEntry = {
		css: readonly string[];
		js: readonly string[];
		panelInit: (ctx: any) => any;
	};
	function loadCorePanelEntry(panelId: string): Promise<CorePanelEntry>;
	function renderPanelBootError(panelId: string, err: any): void;
	/**
	 * Shared PWA / install metadata carried by a panel descriptor.
	 * All text fields are i18n key strings. The AdminTab consumer resolves the runtime URL
	 * against the current shell entry, independent of panel ownership.
	 */
	type AppBlockBase = {
		/** Required: i18n key string for the installable app name. */
		name: string;
		/** Required: host-neutral single-panel target string; resolved against the current shell entry path at runtime. */
		url: string;
		/** Optional: shorter i18n key string; falls back to name when absent. */
		shortName?: string;
		/** Optional: display mode hint for install surfaces. */
		display?: string;
		/** Optional: CSS color value for the browser theme-color meta tag. */
		themeColor?: string;
		/** Optional: CSS color value for manifest/background install surfaces. */
		backgroundColor?: string;
	};

	type CoreAppIconSlots = {
		any192?: string;
		any512?: string;
		maskable192?: string;
		maskable512?: string;
		apple180?: string;
	};

	/**
	 * Core-owned app block variant.
	 * Only core panels expose owner-local `icons`; plugin panels use the generic
	 * host-owned icon set under `admin/icons/pluginUI/` in this AdminTab consumer path.
	 */
	type CoreAppBlock = AppBlockBase & {
		/** Optional fixed icon-slot mapping for core panels; values are owner-local filenames. */
		icons?: CoreAppIconSlots;
	};

	/**
	 * Plugin-owned app block as consumed by the AdminTab shell path in this recut.
	 * Plugin `app.icons` are intentionally not part of this frontend consumer contract.
	 */
	type PluginAppBlock = AppBlockBase;

	type PanelDescriptorLike = {
		id?: string;
		category?: string;
		/** Optional PWA/install metadata; when present, applyAppHeadMeta manages head meta tags. */
		app?: AppBlockBase | CoreAppBlock;
		[key: string]: any;
	};

	type CorePanelRef = {
		type: 'corePanel';
		panelId: string;
	};

	type PluginPanelRef = {
		type: 'pluginPanel';
		pluginType: string;
		instanceId: number;
		panelId: string;
	};

	type CompositionPanelRef = CorePanelRef | PluginPanelRef;

	type AdminTabViewComposition = {
		id?: string;
		layout?: string;
		panels?: CompositionPanelRef[];
		defaultPanel?: string;
		deviceMode?: string;
		app?: AppBlockBase | CoreAppBlock;
	};

	type AdminTabViewResponse = {
		composition?: AdminTabViewComposition;
		corePanels?: Record<string, any>;
		pluginPanels?: Record<string, PluginPanelViewEntry>;
		request?: { mode?: 'composition' | 'panel'; targetId?: string };
	};

	type PluginPanelViewEntry = {
		id: string;
		label: string;
		description?: string;
		category?: string;
		ui: {
			kind: 'plugin';
			loader: 'esm';
			apiVersion: string;
			bundle: { hash: string };
		};
		app?: PluginAppBlock;
	};

	function activatePanel(panelId: string): string;
	function updateDocumentTitle(descriptor?: PanelDescriptorLike): Promise<void>;
	function normalizePluginPanel(panelDef: PluginPanelViewEntry, pluginRef: PluginPanelRef): PanelDescriptorLike;
	function registerPanelDescriptor(descriptor: PanelDescriptorLike): void;
	function resolveIconUrl(descriptor: PanelDescriptorLike, slot: string): Promise<string | null>;
	function generateManifest(
		descriptor: PanelDescriptorLike,
		resolvedIcons: Record<string, { src?: string; mimeType?: string; content?: string }>,
	): object | null;
	function applyCategoryMarker(panelEl: any, category?: string): void;
	function renderPanelModeError(errorKey: string): void;
}
