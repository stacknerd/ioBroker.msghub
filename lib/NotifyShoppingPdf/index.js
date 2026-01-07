/**
 * NotifyShoppingPdf
 * ================
 *
 * MsgHub notify plugin that renders all allowed shopping lists into one PDF and stores it in ioBroker file storage.
 *
 * Docs: ../../docs/plugins/NotifyShoppingPdf.md
 *
 * i18n keys used (English source strings)
 * - 'Total items: %s / printed: %s'
 * - 'Page %s of %s'
 * - 'NOTES'
 * - 'Space for additions:'
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync: nodeSpawnSync } = require('node:child_process');

const { manifest } = require('./manifest');
const { ensureCtxAvailability } = require('../IoPluginGuards');

const toCsvList = csv =>
	String(csv || '')
		.split(',')
		.map(s => s.trim())
		.filter(Boolean);

/**
 * Notify plugin factory.
 *
 * @param {object} [options] Default options (used when instance native is missing keys).
 * @returns {object} Notify plugin.
 */
function NotifyShoppingPdf(options = {}) {
	let initialized = false;

	let log = null;
	let i18n = null;
	let locale = 'en-US';
	let iobroker = null;
	let store = null;
	let constants = null;
	let o = null;
	let plugin = null;
	let resources = null;
	let spawnSyncRef = nodeSpawnSync;

	let cfg = null;
	let stateIds = null;

	const initPromises = new Map();

	let renderTimer = null;
	let rendering = false;
	let rerunRequested = false;

	const ensurePdflatex = () => {
		const r = spawnSyncRef('sh', ['-lc', 'command -v pdflatex'], { encoding: 'utf8' });
		if (r.status !== 0) {
			throw new Error('pdflatex is not available (PATH). Please install texlive.');
		}
	};

	const ensureInitialized = ctx => {
		if (initialized) {
			return;
		}

		ensureCtxAvailability('NotifyShoppingPdf', ctx, {
			plainObject: [
				'api',
				'meta',
				'meta.plugin',
				'meta.options',
				'meta.resources',
				'api.log',
				'api.i18n',
				'api.iobroker',
				'api.store',
				'api.constants',
				'api.iobroker.files',
			],
			stringNonEmpty: ['ctx.api.i18n.locale'],
			fn: [
				'api.log.info',
				'api.log.warn',
				'api.i18n.t',
				'api.iobroker.files.writeFile',
				'api.iobroker.files.mkdir',
				'api.store.queryMessages',
			],
		});

		log = ctx.api.log;
		i18n = ctx.api.i18n;
		locale = ctx.api.i18n.locale;
		iobroker = ctx.api.iobroker;
		store = ctx.api.store;
		constants = ctx.api.constants;
		o = ctx.meta.options;
		plugin = ctx.meta.plugin;
		resources = ctx.meta.resources;
		if (resources && typeof resources.spawnSync === 'function') {
			spawnSyncRef = resources.spawnSync;
		}

		const audienceTagsAny = new Set(toCsvList(o.resolveString('audienceTagsAnyCsv', options.audienceTagsAnyCsv)));

		cfg = Object.freeze({
			includeChecked: o.resolveBool('includeChecked', options.includeChecked),
			includeEmptyCategories: o.resolveBool('includeEmptyCategories', options.includeEmptyCategories),
			printRoomLabelsFromItems: o.resolveInt('printRoomLabelsFromItems', options.printRoomLabelsFromItems),
			uncategorizedLabel: o.resolveString('uncategorizedLabel', options.uncategorizedLabel),
			renderDebounceMs: o.resolveInt('renderDebounceMs', options.renderDebounceMs),
			pdfTitle: o.resolveString('pdfTitle', options.pdfTitle),
			design: o.resolveString('design', options.design),
			notesLines: o.resolveInt('notesLines', options.notesLines),
			audienceTagsAny,
		});

		stateIds = Object.freeze({
			pdfPath: `${plugin.baseOwnId}.pdfPath`,
			pdfUrl: `${plugin.baseOwnId}.pdfUrl`,
		});

		initialized = true;
	};

	const ensureTextState = (id, name, role = 'text') => {
		if (!id) {
			return Promise.resolve();
		}
		if (initPromises.has(id)) {
			return initPromises.get(id);
		}
		const p = iobroker.objects
			.setObjectNotExists(id, {
				type: 'state',
				common: {
					name: name || id,
					type: 'string',
					role,
					read: true,
					write: false,
				},
				native: {},
			})
			.then(() => undefined)
			.catch(err => {
				initPromises.delete(id);
				log.warn(`failed to create state "${id}": ${err?.message || err}`);
			});
		initPromises.set(id, p);
		return p;
	};

	const ensureOwnStates = async () => {
		await Promise.all([
			ensureTextState(stateIds.pdfPath, 'PDF path (ioBroker file storage)', 'text'),
			ensureTextState(stateIds.pdfUrl, 'PDF URL', 'url'),
		]);
	};

	const t = (key, ...args) => i18n.t(key, ...args);

	const stripControlChars = input => {
		const s = String(input ?? '').normalize('NFC');
		let out = '';
		for (const ch of s) {
			const code = ch.codePointAt(0) || 0;
			if (code < 32 || code === 127) {
				out += ' ';
				continue;
			}
			out += ch;
		}
		return out;
	};

	const latexSanitize = s =>
		stripControlChars(s)
			.replace(/[\uFE00-\uFE0F]/g, '')
			.replace(/[\u{E0100}-\u{E01EF}]/gu, '')
			.replace(/\u200D/g, '')
			.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')
			.replace(/\p{Cf}/gu, '')
			.replace(/[–—]/g, '-')
			.replace(/[“”„]/g, '"')
			.replace(/[’]/g, "'")
			.replace(/\p{M}/gu, '')
			.replace(/\s+/g, ' ')
			.trim();

	const latexEscape = s => {
		const str = latexSanitize(s).replace(/\r?\n/g, ' ');
		const map = {
			'\\': '\\textbackslash{}',
			'{': '\\{',
			'}': '\\}',
			$: '\\$',
			'&': '\\&',
			'#': '\\#',
			'%': '\\%',
			_: '\\_',
			'^': '\\textasciicircum{}',
			'~': '\\textasciitilde{}',
		};
		return str.replace(/[\\{}$&#%_^~]/g, ch => map[ch] || ch);
	};

	const renderLatex = model => {
		const design = String(cfg.design || '').toLowerCase() === 'print' ? 'print' : 'screen';
		const printMode = design === 'print';
		const theme = {
			frame: printMode ? 'black!60' : 'black!16',
			rule: printMode ? '0.8pt' : '0.45pt',
			title: printMode ? 'black!15' : 'black!6',
			headRule: printMode ? '0.6pt' : '0.4pt',
			sectioncol: printMode ? 'black!80' : 'black!75',
			metacol: printMode ? 'black!80' : 'black!70',
		};

		const totalPrinted = (model.categories || []).reduce((sum, c) => sum + (Number(c.count) || 0), 0);
		const L = [];
		const add = (s = '') => L.push(s);

		add('\\documentclass[10pt,a4paper]{article}');
		add('\\usepackage[T1]{fontenc}');
		add('\\usepackage[utf8]{inputenc}');
		add('\\usepackage[scaled=0.95]{helvet}');
		add('\\renewcommand{\\familydefault}{\\sfdefault}');
		add('\\usepackage{geometry}');
		add('\\usepackage{xcolor}');
		add('\\usepackage{multicol}');
		add('\\usepackage{tabularx}');
		add('\\usepackage{array}');
		add('\\usepackage{amssymb}');
		add('\\usepackage[hidelinks]{hyperref}');
		add('\\usepackage[most]{tcolorbox}');
		add('\\usepackage{fancyhdr}');
		add('\\usepackage{lastpage}');
		add('\\geometry{margin=12mm, includeheadfoot}');
		add('\\setlength{\\parindent}{0pt}');
		add('\\setlength{\\parskip}{1.5pt}');
		add('\\setlength{\\columnsep}{16pt}');
		add('\\setlength{\\tabcolsep}{3pt}');
		add('\\newcolumntype{Y}{>{\\raggedright\\arraybackslash}X}');
		add('\\sloppy');
		add('');

		const H_TITLE = latexEscape(model.meta.title || '');
		const H_SUB = latexEscape(model.meta.subtitle || '');
		const H_DATE = latexEscape(model.meta.generatedLabel || '');

		add('\\pagestyle{fancy}');
		add('\\fancyhf{}');
		add('\\setlength{\\headheight}{28pt}');
		add(`\\renewcommand{\\headrulewidth}{${theme.headRule}}`);
		add('\\renewcommand{\\footrulewidth}{0px}');
		add('\\fancyhead[C]{%');
		add('  \\parbox[b]{0.78\\textwidth}{\\centering');
		add(`    {\\Large\\bfseries ${H_TITLE}}\\\\[0pt]`);
		add(`   {\\small\\textcolor{${theme.metacol}}{${H_SUB}}}\\\\[4pt]`);
		add('  }%');
		add('}');
		add(
			`\\fancyfoot[L]{\\small\\textcolor{${theme.metacol}}{${latexEscape(t('Total items: %s / printed: %s', model.stats.totalTasks, totalPrinted))}}}`,
		);

		const footerCenterRaw = t('Page %s of %s', 'PAGENUM', 'PAGETOTAL');
		const footerCenter = latexEscape(footerCenterRaw)
			.replace('PAGENUM', '\\thepage')
			.replace('PAGETOTAL', '\\pageref{LastPage}');
		add(`\\fancyfoot[C]{\\small\\textcolor{${theme.metacol}}{${footerCenter}}}`);
		add(`\\fancyfoot[R]{\\small\\textcolor{${theme.metacol}}{${H_DATE}}}`);
		add('');

		add('\\newtcolorbox{CategoryCard}[2]{%');
		add('  enhanced, colback=white,');
		add(`  colframe=${theme.frame}, boxrule=${theme.rule},`);
		add(`  colbacktitle=${theme.title}, coltitle=black,`);
		add('  fonttitle=\\bfseries\\fontsize{11}{13}\\selectfont,');
		add('  title={#1},');
		add('  arc=2.2mm,');
		add('  left=2.2mm, right=2.2mm, top=1.6mm, bottom=1.8mm,');
		add('  toptitle=1.5mm, bottomtitle=1.5mm,');
		add('  before skip=5pt, after skip=6pt');
		add('}');
		add('');

		add('\\newcommand{\\SectionLabelFirst}[1]{%');
		add('  \\par\\addvspace{4pt}%');
		add(`  \\noindent{\\small\\bfseries\\textcolor{${theme.sectioncol}}{#1}}\\par`);
		add('  \\addvspace{4pt}%');
		add('}');
		add('\\newcommand{\\SectionLabelNext}[1]{%');
		add('  \\par\\addvspace{6pt}%');
		add(`  \\noindent{\\small\\bfseries\\textcolor{${theme.sectioncol}}{#1}}\\par`);
		add('  \\addvspace{4pt}%');
		add('}');
		add('');

		add('\\newcommand{\\MetaBlock}[1]{%');
		add(
			`  {\\scriptsize\\textcolor{${theme.metacol}}{\\begin{tabularx}{\\linewidth}{@{}lY@{}}#1\\end{tabularx}}}\\par`,
		);
		add('  \\vspace{4pt}%');
		add('}');
		add('');

		add('\\newenvironment{CategoryBlock}{%');
		add('  \\par\\begin{minipage}[t]{\\columnwidth}');
		add('  \\setlength{\\parindent}{0pt}%');
		add('}{%');
		add('  \\end{minipage}\\par\\vspace{14pt}');
		add('}');
		add('');

		add('\\begin{document}');
		add('\\begin{multicols}{2}');

		for (const cat of model.categories || []) {
			const catName = String(cat.name || '').toUpperCase();
			add('\\begin{CategoryBlock}');
			add(`\\begin{CategoryCard}{${latexEscape(catName)}}{ }`);

			const rooms = cat.rooms || [];
			const totalTasks = rooms.reduce((sum, r) => sum + (r.tasks || []).length, 0);
			const printRoomLabels = totalTasks > (Number(cfg.printRoomLabelsFromItems) || 0);

			for (let i = 0; i < rooms.length; i++) {
				const room = rooms[i];
				const labelCmd = i === 0 ? '\\SectionLabelFirst' : '\\SectionLabelNext';
				if (printRoomLabels) {
					add(`${labelCmd}{${latexEscape(room.label || '')}}`);
				}

				add('\\begin{tabularx}{\\linewidth}{@{}p{1.4em}X@{}}');
				for (const task of room.tasks || []) {
					const main = latexEscape(task.text || '');
					const cb = task.completed ? '\\ensuremath{\\checkmark}' : '\\ensuremath{\\square}';
					add(`${cb} & ${main} \\\\[1pt]`);
				}
				add('\\end{tabularx}');
			}

			add('\\end{CategoryCard}');
			add('\\end{CategoryBlock}');
		}

		if (Number(cfg.notesLines) > 0) {
			add('\\begin{CategoryBlock}');
			add(`\\begin{CategoryCard}{${latexEscape(String(t('NOTES')).toUpperCase())}}{ }`);
			add(`\\MetaBlock{\\textbf{${latexEscape(t('Space for additions:'))}}}`);
			for (let i = 0; i < Number(cfg.notesLines); i++) {
				add('\\noindent\\textcolor{black!25}{\\rule{\\linewidth}{0.35pt}}\\par\\vspace{0.70\\baselineskip}');
			}
			add('\\end{CategoryCard}');
			add('\\end{CategoryBlock}');
		}

		add('\\end{multicols}');
		add('\\end{document}');
		add('');

		return L.join('\n');
	};

	const compileLatexToPdf = (texPath, { runs = 2 } = {}) => {
		const texDir = path.dirname(texPath);
		const texFile = path.basename(texPath);
		const baseName = path.basename(texPath, path.extname(texPath));
		const pdfPath = path.join(texDir, `${baseName}.pdf`);

		const args = [
			'-halt-on-error',
			'-interaction=nonstopmode',
			'-file-line-error',
			`-output-directory=${texDir}`,
			texFile,
		];

		for (let i = 0; i < Math.max(1, runs); i++) {
			const r = spawnSyncRef('pdflatex', args, { cwd: texDir, encoding: 'utf8' });
			if (r.status !== 0) {
				const out = `${r.stdout || ''}\n${r.stderr || ''}`;
				throw new Error(`pdflatex failed (run ${i + 1}/${runs}).\n${out}`);
			}
		}

		return pdfPath;
	};

	const buildModel = ({ subtitle }) => {
		const channel = plugin?.channel || '';
		const now = Date.now();
		const where = {
			kind: constants.kind.shoppinglist,
			timing: { startAt: { max: now, orMissing: true } },
			audience: { channels: { routeTo: channel } },
		};
		const tagsAny = Array.from(cfg.audienceTagsAny || []).filter(Boolean);
		if (tagsAny.length > 0) {
			where.audience = { ...(where.audience || {}), tags: { any: tagsAny } };
		}

		const { items: messages } = store.queryMessages({ where });
		const cats = [];

		for (const msg of messages) {
			if (!msg || typeof msg !== 'object') {
				continue;
			}
			if (msg.kind !== constants.kind.shoppinglist) {
				continue;
			}
			const ref = typeof msg.ref === 'string' ? msg.ref : '';
			if (!ref) {
				continue;
			}

			const items = Array.isArray(msg.listItems) ? msg.listItems : [];
			const roomOrder = [];
			const rooms = new Map(); // label -> { label, tasks }
			let printedCount = 0;
			let totalCount = 0;

			for (const it of items) {
				if (!it || typeof it !== 'object') {
					continue;
				}
				totalCount += 1;

				const completed = it.checked === true;
				if (!cfg.includeChecked && completed) {
					continue;
				}

				const roomLabelRaw = typeof it.category === 'string' ? it.category.trim() : '';
				const roomLabel = roomLabelRaw || cfg.uncategorizedLabel || 'SONSTIGES';
				if (!rooms.has(roomLabel)) {
					rooms.set(roomLabel, { label: roomLabel, tasks: [] });
					roomOrder.push(roomLabel);
				}

				const name = typeof it.name === 'string' ? it.name : String(it.name || '');
				let text = name;
				if (it.quantity && typeof it.quantity === 'object') {
					const qv = it.quantity.val;
					const qu = it.quantity.unit;
					const val = typeof qv === 'number' ? qv : Number(qv);
					const unit = typeof qu === 'string' ? qu.trim() : '';
					if (Number.isFinite(val) && unit) {
						text = `${text} - ${val}${unit}`;
					}
				}

				rooms.get(roomLabel).tasks.push({ text, completed });
				printedCount += 1;
			}

			if (printedCount === 0 && cfg.includeEmptyCategories !== true) {
				continue;
			}

			const title = typeof msg.title === 'string' && msg.title.trim() ? msg.title.trim() : ref;
			cats.push({
				ref,
				name: title,
				count: printedCount,
				total: totalCount,
				rooms: roomOrder.map(label => rooms.get(label)),
			});
		}

		const totalTasks = cats.reduce((sum, c) => sum + (Number(c.total) || 0), 0);

		return {
			meta: {
				title: cfg.pdfTitle || 'Einkaufsliste',
				subtitle: typeof subtitle === 'string' ? subtitle : '',
				generatedLabel: '',
			},
			stats: { totalTasks },
			categories: cats,
		};
	};

	const formatGeneratedSubtitle = async () => {
		const now = new Date();
		const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now);
		const date = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(now);
		const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
		return `${weekday}, ${date} ${time}`;
	};

	const writePdfToStorage = async (pdfPath, metaId, filePath) => {
		let buf = fs.readFileSync(pdfPath);
		if (!Buffer.isBuffer(buf)) {
			buf = Buffer.from(buf);
		}
		try {
			await iobroker.files.mkdir(metaId, path.posix.dirname(filePath));
		} catch {
			// ignore
		}
		await iobroker.files.writeFile(metaId, filePath, buf);
	};

	const toFileSafeName = title => {
		const raw = String(title || '').trim();
		const base = stripControlChars(raw)
			.replace(/[\\/]+/g, ' ')
			.replace(/[<>:"|?*]+/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.replace(/^\.+/, '');
		const name = base && base !== '.' && base !== '..' ? base : `${plugin.type}.${plugin.instanceId}`;
		return `${name.replace(/\.pdf$/i, '')}.pdf`;
	};

	const tryBuildPdfUrl = async (metaId, filePath) => {
		const urlPath = `/files/${metaId}/${filePath}`;
		try {
			const obj = await iobroker.objects.getForeignObject('system.adapter.web.0');
			const port = obj?.native?.port;
			const host = obj?.common?.host;
			const secure = obj?.native?.secure === true;
			if (typeof port === 'number' && Number.isFinite(port) && typeof host === 'string' && host.trim()) {
				return `${secure ? 'https' : 'http'}://${host.trim()}:${Math.trunc(port)}${urlPath}`;
			}
		} catch {
			// ignore
		}
		return urlPath;
	};

	const renderNow = async () => {
		if (rendering) {
			rerunRequested = true;
			return;
		}
		rendering = true;

		try {
			const subtitle = await formatGeneratedSubtitle();
			const model = buildModel({ subtitle });
			const latex = renderLatex(model);

			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msghub-shoppingpdf-'));
			try {
				const texPath = path.join(tmpDir, 'shopping.tex');
				fs.writeFileSync(texPath, latex, 'utf8');
				log.debug(`LaTeX written: ${texPath}`);
				const pdfPath = compileLatexToPdf(texPath, { runs: 2 });
				log.debug(`PDF created: ${pdfPath}`);

				const metaId = iobroker.ids.namespace;
				const fileName = toFileSafeName(cfg.pdfTitle);
				const filePath = `documents/${plugin.type}.${plugin.instanceId}/${fileName}`;
				await writePdfToStorage(pdfPath, metaId, filePath);
				const fsPath = `${metaId}/${filePath}`;
				const url = await tryBuildPdfUrl(metaId, filePath);
				await iobroker.states.setState(stateIds.pdfPath, { val: fsPath, ack: true });
				await iobroker.states.setState(stateIds.pdfUrl, { val: url, ack: true });
				log.info(`PDF updated: ${metaId}/${filePath}`);
			} finally {
				try {
					fs.rmSync(tmpDir, { recursive: true, force: true });
				} catch {
					// ignore
				}
			}
		} finally {
			rendering = false;
			if (rerunRequested) {
				rerunRequested = false;
				await renderNow();
			}
		}
	};

	const scheduleRender = _ctx => {
		if (renderTimer) {
			resources.clearTimeout(renderTimer);
			renderTimer = null;
		}
		const delay = Math.max(0, Number(cfg.renderDebounceMs) || 0);
		renderTimer = resources.setTimeout(() => {
			renderTimer = null;
			renderNow().catch(e => log.warn(`render failed: ${e?.message || e}`));
		}, delay);
	};

	const isShoppingListNotification = notifications => {
		if (!Array.isArray(notifications) || notifications.length === 0) {
			return false;
		}
		const wantedTags = cfg.audienceTagsAny || new Set();
		const hasTagFilter = wantedTags.size > 0;
		for (const msg of notifications) {
			if (!msg || typeof msg !== 'object') {
				continue;
			}
			if (msg.kind !== constants.kind.shoppinglist) {
				continue;
			}
			if (!hasTagFilter) {
				return true;
			}
			const tags = Array.isArray(msg?.audience?.tags) ? msg.audience.tags : [];
			for (const tag of tags) {
				const t = typeof tag === 'string' ? tag.trim() : '';
				if (t && wantedTags.has(t)) {
					return true;
				}
			}
		}
		return false;
	};

	return {
		start(ctx) {
			ensureInitialized(ctx);
			ensurePdflatex();
			ensureOwnStates().catch(e => log.warn(`failed to ensure states: ${e?.message || e}`));
			scheduleRender(ctx);
		},
		stop(ctx) {
			ensureInitialized(ctx);
			if (renderTimer) {
				resources.clearTimeout(renderTimer);
				renderTimer = null;
			}
			log.info('stopped');
		},
		onNotifications(event, notifications, ctx) {
			ensureInitialized(ctx);

			const ev = typeof event === 'string' ? event : '';
			if (
				ev !== constants.notfication.events.added &&
				ev !== constants.notfication.events.update &&
				ev !== constants.notfication.events.deleted &&
				ev !== constants.notfication.events.expired
			) {
				return;
			}
			if (!isShoppingListNotification(notifications)) {
				return;
			}

			scheduleRender(ctx);
		},
	};
}

module.exports = { NotifyShoppingPdf, manifest };
