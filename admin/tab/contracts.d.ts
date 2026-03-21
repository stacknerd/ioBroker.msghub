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
	function getActiveComposition(): any;
	function computeAssetsForComposition(panelIds: string[]): { css: string[]; js: string[] };
	function loadCssFiles(files: string[]): Promise<{ failed: string[] }>;
	function loadJsFilesSequential(files: string[]): Promise<void>;
	function getPanelDefinition(panelId: string): any;
	function renderPanelBootError(panelId: string, err: any): void;
}
