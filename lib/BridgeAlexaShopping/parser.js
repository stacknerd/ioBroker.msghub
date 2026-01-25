'use strict';

const LEXICON_EN = {
	version: 1,
	locale: 'en',
	fallbackLocale: 'en',
	connectors: ['of', 'to', 'for', 'with'],
	multipliers: ['x', '×', 'times'],
	scales: {
		hundred: 100,
		thousand: 1000,
		million: 1000000,
	},
	numberWords: {
		a: 1,
		an: 1,
		one: 1,
		two: 2,
		three: 3,
		four: 4,
		five: 5,
		six: 6,
		seven: 7,
		eight: 8,
		nine: 9,
		ten: 10,
		eleven: 11,
		twelve: 12,
		thirteen: 13,
		fourteen: 14,
		fifteen: 15,
		sixteen: 16,
		seventeen: 17,
		eighteen: 18,
		nineteen: 19,
		twenty: 20,
		twentyone: 21,
		twentytwo: 22,
		twentythree: 23,
		twentyfour: 24,
		twentyfive: 25,
		twentysix: 26,
		twentyseven: 27,
		twentyeight: 28,
		twentynine: 29,
		thirty: 30,
		forty: 40,
		fifty: 50,
		sixty: 60,
		seventy: 70,
		eighty: 80,
		ninety: 90,
	},
	units: [
		// count / packaging
		{ id: 'pcs', type: 'count', aliases: ['pcs', 'pc', 'piece', 'pieces', 'item', 'items'] },
		{ id: 'pack', type: 'count', aliases: ['pack', 'packs', 'package', 'packages', 'pkt'] },
		{ id: 'can', type: 'count', aliases: ['can', 'cans'] },
		{ id: 'bottle', type: 'count', aliases: ['bottle', 'bottles'] },
		{ id: 'bag', type: 'count', aliases: ['bag', 'bags'] },
		{ id: 'box', type: 'count', aliases: ['box', 'boxes'] },
		{ id: 'crate', type: 'count', aliases: ['crate', 'crates', 'case', 'cases'] },
		{ id: 'tray', type: 'count', aliases: ['tray', 'trays'] },
		{ id: 'pallet', type: 'count', aliases: ['pallet', 'pallets'] },
		{ id: 'carton', type: 'count', aliases: ['carton', 'cartons'] },
		{ id: 'cup', type: 'count', aliases: ['cup', 'cups'] },
		{ id: 'jar', type: 'count', aliases: ['jar', 'jars'] },
		{ id: 'tube', type: 'count', aliases: ['tube', 'tubes'] },
		{ id: 'roll', type: 'count', aliases: ['roll', 'rolls'] },

		// mass
		{ id: 'g', type: 'mass', aliases: ['g', 'gram', 'grams'] },
		{ id: 'kg', type: 'mass', aliases: ['kg', 'kilo', 'kilos', 'kilogram', 'kilograms'] },

		// volume
		{ id: 'ml', type: 'volume', aliases: ['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres'] },
		{ id: 'l', type: 'volume', aliases: ['l', 'lt', 'liter', 'liters', 'litre', 'litres'] },
	],
};

const LEXICON_DE = {
	version: 1,
	locale: 'de',
	fallbackLocale: 'en',
	connectors: ['von', 'zu', 'für', 'mit', 'of', 'de', 'di', "d'", 'à', 'a'],
	multipliers: ['x', '×', 'mal'],
	scales: {
		hundert: 100,
		tausend: 1000,
		million: 1000000,
	},
	numberWords: {
		ein: 1,
		eins: 1,
		eine: 1,
		einen: 1,
		einem: 1,
		einer: 1,
		zwei: 2,
		drei: 3,
		vier: 4,
		fuenf: 5,
		fünf: 5,
		sechs: 6,
		sieben: 7,
		acht: 8,
		neun: 9,
		zehn: 10,
		elf: 11,
		zwoelf: 12,
		zwölf: 12,
		dreizehn: 13,
		vierzehn: 14,
		fuenfzehn: 15,
		fünfzehn: 15,
		sechzehn: 16,
		siebzehn: 17,
		achtzehn: 18,
		neunzehn: 19,
		zwanzig: 20,
		einundzwanzig: 21,
		zweiundzwanzig: 22,
		dreiundzwanzig: 23,
		vierundzwanzig: 24,
		fuenfundzwanzig: 25,
		fünfundzwanzig: 25,
		sechsundzwanzig: 26,
		siebenundzwanzig: 27,
		achtundzwanzig: 28,
		neunundzwanzig: 29,
		dreissig: 30,
		dreißig: 30,
		vierzig: 40,
		fuenfzig: 50,
		fünfzig: 50,
		sechzig: 60,
		siebzig: 70,
		achtzig: 80,
		neunzig: 90,
	},
	units: [
		// count / packaging
		{ id: 'pcs', type: 'count', aliases: ['pcs', 'pc', 'x', 'stk', 'stück', 'stueck', 'teile'] },
		{
			id: 'pack',
			type: 'count',
			aliases: ['pack', 'packs', 'packung', 'packungen', 'päckchen', 'paeckchen', 'pkt'],
		},
		{ id: 'can', type: 'count', aliases: ['dose', 'dosen'] },
		{ id: 'bottle', type: 'count', aliases: ['flasche', 'flaschen'] },
		{
			id: 'bag',
			type: 'count',
			aliases: ['beutel', 'beutelchen', 'tüte', 'tüten', 'tuete', 'tueten', 'sack', 'säcke', 'saecke'],
		},
		{ id: 'box', type: 'count', aliases: ['box', 'boxen', 'schachtel', 'schachteln'] },
		{
			id: 'crate',
			type: 'count',
			aliases: ['kasten', 'kaesten', 'kästen', 'kiste', 'kisten', 'getraenkekasten', 'getränkekasten'],
		},
		{ id: 'tray', type: 'count', aliases: ['tray', 'trays', 'träger', 'traeger', 'schale', 'schalen'] },
		{ id: 'pallet', type: 'count', aliases: ['palette', 'paletten'] },
		{ id: 'carton', type: 'count', aliases: ['karton', 'kartons'] },
		{ id: 'cup', type: 'count', aliases: ['becher', 'becherl'] },
		{ id: 'jar', type: 'count', aliases: ['glas', 'gläser', 'glaeser'] },
		{ id: 'tube', type: 'count', aliases: ['tube', 'tuben'] },
		{ id: 'roll', type: 'count', aliases: ['rolle', 'rollen'] },

		// mass
		{ id: 'g', type: 'mass', aliases: ['g', 'gramm', 'gram'] },
		{ id: 'kg', type: 'mass', aliases: ['kg', 'kilo', 'kilogramm', 'kilogram'] },

		// volume
		{ id: 'ml', type: 'volume', aliases: ['ml', 'milliliter', 'millilitre'] },
		{ id: 'l', type: 'volume', aliases: ['l', 'lt', 'liter', 'litre'] },
	],
};

const LEXICONS = Object.freeze({
	// German variants (metric)
	de: LEXICON_DE,
	'de-de': LEXICON_DE,
	'de-at': LEXICON_DE,
	'de-ch': LEXICON_DE,

	// English variants (note: en-US/en-GB will likely diverge later due to imperial units)
	en: LEXICON_EN,
	'en-us': LEXICON_EN,
	'en-gb': LEXICON_EN,
});

/**
 * Normalize an ioBroker locale string to a normalized locale id (lowercase, `-` separated).
 *
 * @param {string} locale Locale string (e.g. `de`, `de-DE`, `en-US`).
 * @returns {string} Normalized locale id (e.g. `de-de`).
 */
const normalizeLocale = locale => {
	const s = String(locale || '')
		.trim()
		.replace(/_/g, '-')
		.toLowerCase();
	return s || 'en';
};

/**
 * Resolve a normalized locale id to a lexicon key.
 *
 * @param {string} locale Normalized locale id (e.g. `de-at`).
 * @returns {string} Lexicon key.
 */
const resolveLexiconKey = locale => {
	const norm = normalizeLocale(locale);
	if (Object.prototype.hasOwnProperty.call(LEXICONS, norm)) {
		return norm;
	}
	const base = norm.split('-')[0] || 'en';
	if (Object.prototype.hasOwnProperty.call(LEXICONS, base)) {
		return base;
	}
	return 'en';
};

/**
 * Normalize raw item strings into a stable form for tokenization.
 *
 * @param {any} raw Raw input.
 * @returns {string} Normalized string.
 */
const normalizeRaw = raw => {
	let s = String(raw ?? '')
		.normalize('NFKC')
		.trim();

	s = s.replace(/[×]/g, 'x').replace(/[–—]/g, '-');
	s = s.replace(/(\d),(\d)/g, '$1.$2');
	s = s.replace(/\s+/g, ' ').trim();

	return s;
};

/**
 * Uppercase only the first character (keeps the remaining casing unchanged).
 *
 * @param {any} s Input string.
 * @returns {string} String with the first character uppercased.
 */
const upperFirst = s => {
	const str = String(s || '');
	if (!str) {
		return '';
	}
	return str.slice(0, 1).toUpperCase() + str.slice(1);
};

/**
 * Parse free-text shopping list entries into `{ name, quantity, perUnit }`.
 */
class ShoppingItemParser {
	/**
	 * @param {object} [options] Parser options.
	 * @param {string} [options.locale] Locale for lexicon selection (e.g. `de`, `en`).
	 * @param {boolean} [options.keepDebug] Include debug information in results.
	 * @param {object|null} [options.lexicon] Custom lexicon override.
	 */
	constructor({ locale = 'en', keepDebug = false, lexicon = null } = {}) {
		this.keepDebug = !!keepDebug;
		this.locale = normalizeLocale(locale);

		const lexiconKey = resolveLexiconKey(this.locale);
		this.lexiconKey = lexiconKey;

		const lx = lexicon && typeof lexicon === 'object' ? lexicon : LEXICONS[lexiconKey] || LEXICONS.en;
		this.lexicon = lx;
		const fallbackKey = resolveLexiconKey(lx.fallbackLocale);
		this.fallbackLexicon = LEXICONS[fallbackKey] || LEXICONS.en;

		this._idx = {
			aliasToUnit: new Map(),
			multipliers: new Set(),
			connectors: new Set(),
			scales: new Map(),
			numberWords: new Map(),
			countUnitIds: new Set(),
			measureUnitIds: new Set(),
		};
		this._fallbackIdx = {
			aliasToUnit: new Map(),
			multipliers: new Set(),
			connectors: new Set(),
			scales: new Map(),
			numberWords: new Map(),
			countUnitIds: new Set(),
			measureUnitIds: new Set(),
		};

		this._buildIndex();
	}

	/**
	 * Parse a free-text item string into a structured representation.
	 *
	 * @param {any} raw Raw input.
	 * @returns {{ name: string, confidence: number, quantity?: { val: number, unit: string }, perUnit?: { val: number, unit: string }, debug?: object }} Result.
	 */
	parse(raw) {
		const normalized = normalizeRaw(raw);
		if (!normalized) {
			return { name: '', confidence: 0 };
		}

		const origTokens = normalized.split(/\s+/).filter(Boolean);
		const lowerTokens = origTokens.map(t => this._normalizeTokenForMatching(t));

		const matches = [];
		matches.push(this._tryMultipack({ lowerTokens }));
		matches.push(this._tryCountMeasurePackaging({ lowerTokens }));
		matches.push(this._tryCountWithPackaging({ lowerTokens }));
		matches.push(this._tryMeasureWithPackaging({ lowerTokens }));
		matches.push(this._tryMeasureOnly({ lowerTokens }));
		matches.push(this._tryCountOnly({ lowerTokens }));
		matches.push(this._tryLeadingPackagingWithoutCount({ lowerTokens }));

		let best = null;
		for (const m of matches) {
			if (!m) {
				continue;
			}
			if (!best || (m.score || 0) > (best.score || 0)) {
				best = m;
			}
		}

		if (!best) {
			return this._buildOut({
				raw,
				normalized,
				origTokens,
				removeIdx: new Set(),
				quantity: null,
				perUnit: null,
				confidence: 0.15,
				reason: 'no match',
			});
		}

		return this._buildOut({
			raw,
			normalized,
			origTokens,
			removeIdx: best.removeIdx,
			quantity: best.quantity,
			perUnit: best.perUnit,
			confidence: best.confidence,
			reason: best.reason,
		});
	}

	/**
	 * Build internal lookup maps for the active locale (and fallback locale).
	 */
	_buildIndex() {
		const make = lx => {
			const aliasToUnit = new Map();
			const multipliers = new Set((lx.multipliers || []).map(x => String(x).toLowerCase()));
			const connectors = new Set((lx.connectors || []).map(x => String(x).toLowerCase()));
			const scales = new Map(
				Object.entries(lx.scales || {}).map(([k, v]) => [String(k).toLowerCase(), Number(v)]),
			);
			const numberWords = new Map(
				Object.entries(lx.numberWords || {}).map(([k, v]) => [String(k).toLowerCase(), v]),
			);
			const countUnitIds = new Set();
			const measureUnitIds = new Set();

			for (const u of lx.units || []) {
				if (!u || typeof u !== 'object') {
					continue;
				}
				const id = String(u.id || '').trim();
				const type = String(u.type || '').trim();
				if (!id || !type) {
					continue;
				}

				if (type === 'count') {
					countUnitIds.add(id);
				}
				if (type === 'mass' || type === 'volume') {
					measureUnitIds.add(id);
				}

				for (const a of u.aliases || []) {
					const key = String(a || '')
						.trim()
						.toLowerCase();
					if (!key) {
						continue;
					}
					aliasToUnit.set(key, { id, type });
				}
			}

			return { aliasToUnit, multipliers, connectors, scales, numberWords, countUnitIds, measureUnitIds };
		};

		this._idx = make(this.lexicon);
		this._fallbackIdx = make(this.fallbackLexicon);
	}

	/**
	 * Build the final output object and re-assemble the remaining tokens into `name`.
	 *
	 * @param {object} info Build info.
	 * @param {any} info.raw Raw input.
	 * @param {string} info.normalized Normalized raw string.
	 * @param {string[]} info.origTokens Original tokens.
	 * @param {Set<number>} info.removeIdx Indices to remove from origTokens.
	 * @param {{ val: number, unit: string }|null} info.quantity Quantity.
	 * @param {{ val: number, unit: string }|null} info.perUnit Per-unit measurement.
	 * @param {number} info.confidence Confidence (0..1).
	 * @param {string} info.reason Match reason.
	 * @returns {object} Output.
	 */
	_buildOut({ raw, normalized, origTokens, removeIdx, quantity, perUnit, confidence, reason }) {
		const keep = origTokens.filter((_, idx) => !removeIdx.has(idx));
		let name = keep.join(' ').replace(/\s+/g, ' ').trim();
		name = upperFirst(name);

		const out = {
			name,
			confidence: this._clamp01(confidence),
		};
		if (quantity) {
			out.quantity = quantity;
		}
		if (perUnit) {
			out.perUnit = perUnit;
		}

		if (this.keepDebug) {
			out.debug = {
				raw: String(raw ?? ''),
				normalized,
				locale: this.locale,
				lexicon: this.lexiconKey,
				reason,
				removeIdx: Array.from(removeIdx.values()).sort((a, b) => a - b),
			};
		}

		return out;
	}

	/**
	 * Parse patterns like `6x ... 500g` → `quantity=6 pcs`, `perUnit=500 g`.
	 *
	 * @param {object} info Info.
	 * @param {string[]} info.lowerTokens Lowercased tokens.
	 * @returns {object|null} Match.
	 */
	_tryMultipack({ lowerTokens }) {
		const removeIdx = new Set();

		for (let i = 0; i < lowerTokens.length; i++) {
			const countWithX = this._parseCountWithAttachedMultiplier(lowerTokens[i]);
			let count = null;
			let countEnd = i;
			let multiplierAt = null;

			if (countWithX) {
				count = countWithX.val;
				multiplierAt = i;
				removeIdx.add(i);
			} else {
				const c = this._parseCountToken(lowerTokens[i]);
				if (c == null) {
					continue;
				}
				if (i + 1 >= lowerTokens.length) {
					continue;
				}
				if (!this._isMultiplier(lowerTokens[i + 1])) {
					continue;
				}

				count = c;
				countEnd = i;
				multiplierAt = i + 1;
				removeIdx.add(i);
				removeIdx.add(i + 1);
			}

			if (!Number.isFinite(count) || !(count > 0)) {
				continue;
			}

			// Find the first measure token after the multiplier (or anywhere after the count token).
			const searchFrom = multiplierAt != null ? multiplierAt + 1 : countEnd + 1;
			const measure = this._findFirstMeasure({ lowerTokens, from: searchFrom });
			if (!measure) {
				// Support "5x <name>" (multiplier without perUnit) as count-only.
				// Also support "5x dosen cola" as count+packaging.
				const packaging = this._findFirstPackaging({ lowerTokens, from: searchFrom, until: searchFrom + 2 });
				const countUnit = packaging?.unitId || 'pcs';
				if (packaging) {
					for (const idx of packaging.removeIdx) {
						removeIdx.add(idx);
					}
				}
				const confidence = this._score({
					hasCount: true,
					hasPerUnit: false,
					hasPackaging: countUnit !== 'pcs',
				});
				return {
					reason: 'multiplier-without-measure',
					score: 55 + confidence,
					confidence,
					removeIdx,
					quantity: { val: Math.trunc(count), unit: countUnit },
					perUnit: null,
				};
			}

			for (const idx of measure.removeIdx) {
				removeIdx.add(idx);
			}

			const packaging = this._findFirstPackaging({ lowerTokens, from: searchFrom, until: measure.firstIdx });
			const countUnit = packaging?.unitId || 'pcs';
			if (packaging) {
				for (const idx of packaging.removeIdx) {
					removeIdx.add(idx);
				}
			}

			const quantity = { val: Math.trunc(count), unit: countUnit };
			const perUnit = { val: measure.val, unit: measure.unitId };

			const confidence = this._score({ hasCount: true, hasPerUnit: true, hasPackaging: !!packaging });
			return {
				reason: 'multipack',
				score: 90 + confidence,
				confidence,
				removeIdx,
				quantity,
				perUnit,
			};
		}

		return null;
	}

	/**
	 * Parse patterns like `5 dosen cola` → `quantity=5 can`.
	 *
	 * @param {object} info Info.
	 * @param {string[]} info.lowerTokens Lowercased tokens.
	 * @returns {object|null} Match.
	 */
	_tryCountWithPackaging({ lowerTokens }) {
		for (let i = 0; i < lowerTokens.length - 1; i++) {
			const num = this._parseNumberSpan(lowerTokens, i, { allowDecimal: false, maxLen: 5 });
			if (!num || !(num.val > 0)) {
				continue;
			}
			const count = num.val;

			const pkgTok = lowerTokens[i + num.len];
			const pkg = this._parseUnitToken(pkgTok);
			if (!pkg || pkg.type !== 'count') {
				continue;
			}

			const removeIdx = new Set();
			for (let k = 0; k < num.len; k++) {
				removeIdx.add(i + k);
			}
			removeIdx.add(i + num.len);

			const measure = this._findFirstMeasure({ lowerTokens, from: i + num.len + 1 });
			if (measure) {
				for (const idx of measure.removeIdx) {
					removeIdx.add(idx);
				}
			}

			const quantity = { val: Math.trunc(count), unit: pkg.id };
			const perUnit = measure ? { val: measure.val, unit: measure.unitId } : null;
			const confidence = this._score({ hasCount: true, hasPerUnit: !!perUnit, hasPackaging: true });

			return {
				reason: 'count+packaging',
				score: 80 + confidence,
				confidence,
				removeIdx,
				quantity,
				perUnit,
			};
		}

		return null;
	}

	/**
	 * Parse patterns like `fünf ein liter Becher eis` → `quantity=5 cup`, `perUnit=1 l`.
	 *
	 * @param {object} info Info.
	 * @param {string[]} info.lowerTokens Lowercased tokens.
	 * @returns {object|null} Match.
	 */
	_tryCountMeasurePackaging({ lowerTokens }) {
		for (let i = 0; i < lowerTokens.length - 2; i++) {
			const num = this._parseNumberSpan(lowerTokens, i, { allowDecimal: false, maxLen: 5 });
			if (!num || !(num.val > 0)) {
				continue;
			}
			const count = num.val;

			const measure = this._parseMeasureAt(lowerTokens, i + num.len);
			if (!measure) {
				continue;
			}

			const pkgTok = lowerTokens[i + num.len + measure.len];
			const pkg = pkgTok ? this._parseUnitToken(pkgTok) : null;
			if (!pkg || pkg.type !== 'count') {
				continue;
			}

			const removeIdx = new Set();
			for (let k = 0; k < num.len; k++) {
				removeIdx.add(i + k);
			}
			for (let k = 0; k < measure.len; k++) {
				removeIdx.add(i + num.len + k);
			}
			removeIdx.add(i + num.len + measure.len);

			const quantity = { val: Math.trunc(count), unit: pkg.id };
			const perUnit = { val: measure.val, unit: measure.unitId };
			const confidence = this._score({ hasCount: true, hasPerUnit: true, hasPackaging: true });

			return {
				reason: 'count+measure+packaging',
				score: 78 + confidence,
				confidence,
				removeIdx,
				quantity,
				perUnit,
			};
		}

		return null;
	}

	/**
	 * Parse patterns like `500g Packung Nudeln` → `quantity=1 pack`, `perUnit=500 g`.
	 *
	 * @param {object} info Info.
	 * @param {string[]} info.lowerTokens Lowercased tokens.
	 * @returns {object|null} Match.
	 */
	_tryMeasureWithPackaging({ lowerTokens }) {
		for (let i = 0; i < lowerTokens.length; i++) {
			const measure = this._parseMeasureAt(lowerTokens, i);
			if (!measure) {
				continue;
			}

			// Try packaging word after measure (e.g. "500g packung nudeln")
			const pkgTok = lowerTokens[i + measure.len];
			const pkg = pkgTok ? this._parseUnitToken(pkgTok) : null;
			if (!pkg || pkg.type !== 'count') {
				continue;
			}

			const removeIdx = new Set();
			for (let k = 0; k < measure.len; k++) {
				removeIdx.add(i + k);
			}
			removeIdx.add(i + measure.len);

			const quantity = { val: 1, unit: pkg.id };
			const perUnit = { val: measure.val, unit: measure.unitId };
			const confidence = this._score({ hasCount: true, hasPerUnit: true, hasPackaging: true });

			return {
				reason: 'measure+packaging',
				score: 75 + confidence,
				confidence,
				removeIdx,
				quantity,
				perUnit,
			};
		}

		return null;
	}

	/**
	 * Parse patterns like `1l Cola` into `quantity=1 pcs`, `perUnit=1 l`.
	 *
	 * @param {object} info Info.
	 * @param {string[]} info.lowerTokens Lowercased tokens.
	 * @returns {object|null} Match.
	 */
	_tryMeasureOnly({ lowerTokens }) {
		const measure = this._findFirstMeasure({ lowerTokens, from: 0 });
		if (!measure) {
			return null;
		}

		const removeIdx = new Set(measure.removeIdx);
		const perUnit = { val: measure.val, unit: measure.unitId };

		const quantity = { val: 1, unit: 'pcs' };
		const confidence = this._score({ hasCount: true, hasPerUnit: true, hasPackaging: false });

		return {
			reason: 'measure-only',
			score: 60 + confidence,
			confidence,
			removeIdx,
			quantity,
			perUnit,
		};
	}

	/**
	 * Parse patterns like `sechs butter` into `quantity=6 pcs`.
	 *
	 * @param {object} info Info.
	 * @param {string[]} info.lowerTokens Lowercased tokens.
	 * @returns {object|null} Match.
	 */
	_tryCountOnly({ lowerTokens }) {
		for (let i = 0; i < lowerTokens.length; i++) {
			const num = this._parseNumberSpan(lowerTokens, i, { allowDecimal: false, maxLen: 5 });
			if (!num || !(num.val > 0)) {
				continue;
			}
			const count = num.val;

			const maybeMeasureUnitTok = lowerTokens[i + num.len];
			const maybeMeasureUnit = maybeMeasureUnitTok ? this._parseUnitToken(maybeMeasureUnitTok) : null;
			if (maybeMeasureUnit && (maybeMeasureUnit.type === 'mass' || maybeMeasureUnit.type === 'volume')) {
				continue;
			}

			const removeIdx = new Set();
			for (let k = 0; k < num.len; k++) {
				removeIdx.add(i + k);
			}
			let unitId = 'pcs';

			const pkgTok = lowerTokens[i + num.len];
			const pkg = pkgTok ? this._parseUnitToken(pkgTok) : null;
			if (pkg && pkg.type === 'count') {
				unitId = pkg.id;
				removeIdx.add(i + num.len);
			}

			const confidence = this._score({ hasCount: true, hasPerUnit: false, hasPackaging: unitId !== 'pcs' });
			return {
				reason: 'count-only',
				score: 50 + confidence,
				confidence,
				removeIdx,
				quantity: { val: Math.trunc(count), unit: unitId },
				perUnit: null,
			};
		}

		return null;
	}

	/**
	 * Parse patterns like `dose kichererbsen` into `quantity=1 can`.
	 * Applies only when a known count unit starts the string with no leading number.
	 *
	 * @param {object} info Info.
	 * @param {string[]} info.lowerTokens Lowercased tokens.
	 * @returns {object|null} Match.
	 */
	_tryLeadingPackagingWithoutCount({ lowerTokens }) {
		if (!lowerTokens.length) {
			return null;
		}

		const first = lowerTokens[0];
		if (this._parseCountToken(first) != null) {
			return null;
		}

		const unit = this._parseUnitToken(first);
		if (!unit || unit.type !== 'count') {
			return null;
		}

		const second = lowerTokens[1];
		if (this._parseCountToken(second) != null) {
			return null;
		}

		const removeIdx = new Set([0]);
		if (second && this._isConnector(second)) {
			removeIdx.add(1);
		}

		const confidence = this._clamp01(this._score({ hasCount: true, hasPerUnit: false, hasPackaging: true }) - 0.2);
		return {
			reason: 'leading-packaging-without-count',
			score: 40 + confidence,
			confidence,
			removeIdx,
			quantity: { val: 1, unit: unit.id },
			perUnit: null,
		};
	}

	/**
	 * Find the first mass/volume measurement starting at index.
	 *
	 * @param {object} info Info.
	 * @param {string[]} info.lowerTokens Lowercased tokens.
	 * @param {number} info.from Start index.
	 * @returns {object|null} Match.
	 */
	_findFirstMeasure({ lowerTokens, from = 0 }) {
		for (let i = from; i < lowerTokens.length; i++) {
			const measure = this._parseMeasureAt(lowerTokens, i);
			if (!measure) {
				continue;
			}

			const removeIdx = new Set();
			for (let k = 0; k < measure.len; k++) {
				removeIdx.add(i + k);
			}
			return { ...measure, removeIdx, firstIdx: i };
		}
		return null;
	}

	/**
	 * Find the first packaging/count token in a token range.
	 *
	 * @param {object} info Info.
	 * @param {string[]} info.lowerTokens Lowercased tokens.
	 * @param {number} info.from Start index.
	 * @param {number} info.until End index.
	 * @returns {object|null} Match.
	 */
	_findFirstPackaging({ lowerTokens, from = 0, until = lowerTokens.length }) {
		for (let i = from; i < Math.min(until, lowerTokens.length); i++) {
			const u = this._parseUnitToken(lowerTokens[i]);
			if (!u || u.type !== 'count') {
				continue;
			}
			return { unitId: u.id, removeIdx: new Set([i]) };
		}
		return null;
	}

	/**
	 * Parse a measurement at a token position.
	 *
	 * Supports:
	 * - attached: `500g`, `1.5l`
	 * - separated: `500 g`, `1.5 l` (optionally with a connector after the unit)
	 *
	 * @param {string[]} tokens Lowercased tokens.
	 * @param {number} i Index.
	 * @returns {{ val: number, unitId: string, len: number }|null} Measurement match.
	 */
	_parseMeasureAt(tokens, i) {
		const t = tokens[i];
		if (!t) {
			return null;
		}

		// Attached: "500g", "1.5l"
		const m = t.match(/^(\d+(?:\.\d+)?)([a-zäöüß]+)$/i);
		if (m) {
			const val = Number(m[1]);
			const unitTok = String(m[2] || '').toLowerCase();
			const unit = this._parseUnitToken(unitTok);
			if (Number.isFinite(val) && val > 0 && unit && (unit.type === 'mass' || unit.type === 'volume')) {
				return { val, unitId: unit.id, len: 1 };
			}
		}

		// Separated: "<number> <unit>" (supports composite number words like "zwei hundert")
		const num = this._parseNumberSpan(tokens, i, { allowDecimal: true, maxLen: 5 });
		if (!num || !(num.val > 0)) {
			return null;
		}
		const unitTok = tokens[i + num.len] || null;
		const unit = unitTok ? this._parseUnitToken(unitTok) : null;
		if (unit && (unit.type === 'mass' || unit.type === 'volume')) {
			// optional connector token right after unit ("2 l of milk")
			const connectorIdx = i + num.len + 1;
			const connector = tokens[connectorIdx] && this._isConnector(tokens[connectorIdx]) ? 1 : 0;
			return { val: num.val, unitId: unit.id, len: num.len + 1 + connector };
		}

		return null;
	}

	/**
	 * Parse a number span starting at an index (supports locale-specific scale words, e.g. "hundert").
	 *
	 * @param {string[]} tokens Lowercased tokens.
	 * @param {number} from Start index.
	 * @param {object} [options] Options.
	 * @param {boolean} [options.allowDecimal] Allow decimals (only as a single numeric token).
	 * @param {number} [options.maxLen] Maximum tokens to consume.
	 * @returns {{ val: number, len: number }|null} Parsed number and token length.
	 */
	_parseNumberSpan(tokens, from, { allowDecimal = false, maxLen = 4 } = {}) {
		const t0 = tokens[from];
		if (!t0) {
			return null;
		}

		const numeric = String(t0 || '')
			.trim()
			.toLowerCase();
		const numericRe = allowDecimal ? /^\d+(?:\.\d+)?$/ : /^\d+$/;
		if (numericRe.test(numeric)) {
			const n = Number(numeric);
			if (!Number.isFinite(n) || !(n > 0)) {
				return null;
			}
			return { val: n, len: 1 };
		}

		const getNumberWord = word =>
			this._idx?.numberWords?.get(word) ?? this._fallbackIdx?.numberWords?.get(word) ?? null;
		const getScale = word => this._idx?.scales?.get(word) ?? this._fallbackIdx?.scales?.get(word) ?? null;

		let total = 0;
		let current = 0;
		let consumed = 0;
		let sawScale = false;

		for (let i = from; i < Math.min(tokens.length, from + Math.max(1, maxLen)); i++) {
			const raw = String(tokens[i] || '')
				.trim()
				.toLowerCase();
			if (!raw) {
				break;
			}

			// Stop on plain numbers after we've started parsing words (do not mix formats).
			if (/^\d+(?:\.\d+)?$/.test(raw)) {
				break;
			}

			const word = raw.replace(/[^\p{L}]+/gu, '');
			if (!word) {
				break;
			}

			const nw = getNumberWord(word);
			if (Number.isFinite(nw) && nw > 0) {
				current += nw;
				consumed++;

				// Do not greedily sum multiple number words unless a scale word is involved.
				// This avoids mis-parsing patterns like "fünf ein liter" as "6 liter".
				if (!sawScale) {
					const nextRaw = String(tokens[i + 1] || '')
						.trim()
						.toLowerCase();
					const nextWord = nextRaw.replace(/[^\p{L}]+/gu, '');
					const nextScale = nextWord ? getScale(nextWord) : null;
					if (!Number.isFinite(nextScale) || !(nextScale > 1)) {
						break;
					}
				}
				continue;
			}

			const scale = getScale(word);
			if (Number.isFinite(scale) && scale > 0) {
				const factor = Math.trunc(scale);
				if (!(factor > 1)) {
					break;
				}
				if (current === 0) {
					current = 1;
				}
				current *= factor;
				total += current;
				current = 0;
				consumed++;
				sawScale = true;
				continue;
			}

			break;
		}

		const val = total + current;
		if (consumed === 0 || !Number.isFinite(val) || !(val > 0)) {
			return null;
		}

		return { val, len: consumed };
	}

	/**
	 * Parse patterns like `5x` into count.
	 *
	 * @param {any} token Token.
	 * @returns {{ val: number }|null} Match.
	 */
	_parseCountWithAttachedMultiplier(token) {
		const t = String(token || '')
			.trim()
			.toLowerCase();
		const m = t.match(/^(\d+)\s*x$/);
		if (!m) {
			return null;
		}
		const val = Number(m[1]);
		return Number.isFinite(val) && val > 0 ? { val } : null;
	}

	/**
	 * Parse count tokens (digits or configured number words).
	 *
	 * @param {any} token Token.
	 * @returns {number|null} Parsed number.
	 */
	_parseCountToken(token) {
		const t = String(token || '')
			.trim()
			.toLowerCase();

		if (/^\d+$/.test(t)) {
			const n = Number(t);
			return Number.isFinite(n) && n > 0 ? n : null;
		}

		const word = t.replace(/[^\p{L}]+/gu, '');
		const fromLex = this._idx?.numberWords?.get(word) ?? this._fallbackIdx?.numberWords?.get(word);
		if (Number.isFinite(fromLex) && fromLex > 0) {
			return fromLex;
		}

		return null;
	}

	/**
	 * Parse numeric tokens usable for measurements (digits/decimals or configured number words).
	 *
	 * @param {any} token Token.
	 * @returns {number|null} Parsed number.
	 */
	_parseMeasureNumberToken(token) {
		const t = String(token || '')
			.trim()
			.toLowerCase();
		if (/^\d+(?:\.\d+)?$/.test(t)) {
			const n = Number(t);
			return Number.isFinite(n) ? n : null;
		}

		// allow "ein/eine/one" as 1 for measures, too
		const word = t.replace(/[^\p{L}]+/gu, '');
		const fromLex = this._idx?.numberWords?.get(word) ?? this._fallbackIdx?.numberWords?.get(word);
		if (Number.isFinite(fromLex) && fromLex > 0) {
			return fromLex;
		}

		return null;
	}

	/**
	 * Resolve a token to a known unit (count/mass/volume), using locale + fallback locale.
	 *
	 * @param {any} token Token.
	 * @returns {{ id: string, type: string }|null} Unit match.
	 */
	_parseUnitToken(token) {
		const t = String(token || '')
			.trim()
			.toLowerCase()
			.replace(/^[([<{]+/g, '')
			.replace(/[)\]}>.,;:!?]+$/g, '');

		const u = this._idx?.aliasToUnit?.get(t) || this._fallbackIdx?.aliasToUnit?.get(t);
		return u || null;
	}

	/**
	 * @param {any} token Token.
	 * @returns {boolean} True when the token is a multiplier (`x`, `mal`, ...).
	 */
	_isMultiplier(token) {
		const t = String(token || '')
			.trim()
			.toLowerCase();
		return !!(this._idx?.multipliers?.has(t) || this._fallbackIdx?.multipliers?.has(t));
	}

	/**
	 * @param {any} token Token.
	 * @returns {boolean} True when the token is a connector (`von`, `of`, ...).
	 */
	_isConnector(token) {
		const t = String(token || '')
			.trim()
			.toLowerCase();
		return !!(this._idx?.connectors?.has(t) || this._fallbackIdx?.connectors?.has(t));
	}

	/**
	 * Normalize tokens for matching (lowercase + remove common quotes).
	 *
	 * @param {any} token Token.
	 * @returns {string} Normalized token.
	 */
	_normalizeTokenForMatching(token) {
		return String(token || '')
			.trim()
			.toLowerCase()
			.replace(/[“”„"]/g, '')
			.replace(/[’']/g, "'")
			.replace(/\s+/g, ' ');
	}

	/**
	 * Compute a heuristic confidence score.
	 *
	 * @param {object} info Info.
	 * @param {boolean} info.hasCount Whether a count was parsed.
	 * @param {boolean} info.hasPerUnit Whether a per-unit measure was parsed.
	 * @param {boolean} info.hasPackaging Whether a non-generic packaging unit was parsed.
	 * @returns {number} Confidence (0..1).
	 */
	_score({ hasCount, hasPerUnit, hasPackaging }) {
		let c = 0.15;
		if (hasCount) {
			c += 0.35;
		}
		if (hasPerUnit) {
			c += 0.35;
		}
		if (hasPackaging) {
			c += 0.05;
		}
		return this._clamp01(c);
	}

	/**
	 * @param {any} x Input.
	 * @returns {number} Number clamped to [0..1].
	 */
	_clamp01(x) {
		return Math.max(0, Math.min(1, Number(x) || 0));
	}
}

module.exports = {
	LEXICON_DE,
	LEXICON_EN,
	LEXICONS,
	ShoppingItemParser,
	normalizeLocale,
	resolveLexiconKey,
	normalizeRaw,
};
