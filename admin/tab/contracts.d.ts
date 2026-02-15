export {};

declare global {
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
	const socket: any;
	const lang: string;

	function sendTo(command: string, message: any): Promise<any>;
	function h(tag: string, attrs?: any, children?: any): HTMLElement;
	function pickText(value: any): string;

	function ensureAdminI18nLoaded(): Promise<void>;
	function hasAdminKey(key: string): boolean;
	function t(key: string, ...args: any[]): string;
	function readThemeFromTopWindow(): 'dark' | 'light' | null;
	function applyTheme(nextTheme: 'dark' | 'light'): void;
	function detectTheme(): 'dark' | 'light';

	function computeContextMenuPosition(params: any): { x: number; y: number };
	function toContextMenuIconVar(iconName: string): string;
	function createAdminApi(deps: any): any;

	function createUi(): any;

	function initTabs(options?: any): void;
	function buildLayoutFromRegistry(): {
		layout: 'tabs' | 'single';
		panelIds: string[];
		defaultPanelId: string;
	};
	function getActiveComposition(): any;
	function computeAssetsForComposition(panelIds: string[]): { css: string[]; js: string[] };
	function loadCssFiles(files: string[]): Promise<{ failed: string[] }>;
	function loadJsFilesSequential(files: string[]): Promise<void>;
	function getPanelDefinition(panelId: string): any;
	function renderPanelBootError(panelId: string, err: any): void;
}
