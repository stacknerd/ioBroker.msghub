'use strict';

const { expect } = require('chai');
const { MsgRender } = require('./MsgRender');

describe('MsgRender', () => {
	const locale = 'en-GB';

	function createRenderer(options = {}) {
		return new MsgRender({ log: { info: () => {} } }, options);
	}

	function buildMetrics(entries) {
		return new Map(entries);
	}

	function createMessage({ title = '', text = '', details = undefined, metrics, timing } = {}) {
		return { title, text, details, metrics, timing };
	}

	it('renders a basic metric with unit', () => {
		const renderer = createRenderer({ locale });
		const metrics = buildMetrics([['temperature', { val: 21.75, unit: 'C', ts: Date.UTC(2025, 0, 1) }]]);
		const msg = createMessage({ title: 'Temp {{m.temperature}}', metrics });

		const out = renderer.renderMessage(msg);
		const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });

		expect(out.title).to.equal(`Temp ${nf.format(21.75)} C`);
		expect(out).to.not.have.property('display');
	});

	it('renders explicit val, unit, and ts fields', () => {
		const renderer = createRenderer({ locale });
		const ts = Date.UTC(2025, 0, 2);
		const metrics = buildMetrics([['temperature', { val: 21.75, unit: 'C', ts }]]);
		const msg = createMessage({ title: 'V{{m.temperature.val}} U {{m.temperature.unit}} T{{m.temperature.ts}}', metrics });

		const out = renderer.renderMessage(msg);

		expect(out.title).to.equal(`V21.75 U C T${ts}`);
	});

	it('applies num filter to numbers', () => {
		const renderer = createRenderer({ locale });
		const metrics = buildMetrics([['humidity', { val: 46.234, unit: '%', ts: Date.UTC(2025, 0, 3) }]]);
		const msg = createMessage({ title: '{{m.humidity.val|num:1}}', metrics });

		const out = renderer.renderMessage(msg);
		const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });

		expect(out.title).to.equal(nf.format(46.234));
	});

	it('applies num filter to numeric strings', () => {
		const renderer = createRenderer({ locale });
		const metrics = buildMetrics([['sval', { val: '12.9', unit: 'C', ts: Date.UTC(2025, 0, 4) }]]);
		const msg = createMessage({ title: '{{m.sval.val|num:0}}', metrics });

		const out = renderer.renderMessage(msg);
		const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });

		expect(out.title).to.equal(nf.format(12.9));
	});

	it('applies datetime filter to timestamps', () => {
		const renderer = createRenderer({ locale });
		const ts = Date.UTC(2025, 0, 5, 13, 45, 0);
		const metrics = buildMetrics([['lastSeen', { val: 1, unit: 'n/a', ts }]]);
		const msg = createMessage({ title: '{{m.lastSeen.ts|datetime}}', metrics });

		const out = renderer.renderMessage(msg);
		const df = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

		expect(out.title).to.equal(df.format(new Date(ts)));
	});

	it('applies durationSince filter with the expected formatting buckets', () => {
		const renderer = createRenderer({ locale });

		const originalNow = Date.now;
		const now = Date.UTC(2025, 0, 10, 12, 0, 0);
		Date.now = () => now;
		try {
			const metrics = buildMetrics([
				['a', { val: now - 56_000, unit: 'ms', ts: now }],
				['b', { val: now - 34 * 60_000, unit: 'ms', ts: now }],
				['c', { val: now - (3 * 60 + 45) * 60_000, unit: 'ms', ts: now }],
				['d', { val: now - (24 * 60 + 4 * 60) * 60_000, unit: 'ms', ts: now }],
				['future', { val: now + 10_000, unit: 'ms', ts: now }],
			]);
			const msg = createMessage({
				title: '{{m.a|durationSince}}/{{m.b|durationSince}}/{{m.c|durationSince}}/{{m.d|durationSince}}/{{m.future|durationSince}}',
				metrics,
			});

			const out = renderer.renderMessage(msg);
			expect(out.title).to.equal('56s/34m/3:45h/1d 4h/');
		} finally {
			Date.now = originalNow;
		}
	});

	it('applies durationUntil filter and hides past timestamps', () => {
		const renderer = createRenderer({ locale });

		const originalNow = Date.now;
		const now = Date.UTC(2025, 0, 10, 12, 0, 0);
		Date.now = () => now;
		try {
			const metrics = buildMetrics([
				['a', { val: now + 56_000, unit: 'ms', ts: now }],
				['b', { val: now + 34 * 60_000, unit: 'ms', ts: now }],
				['c', { val: now + (3 * 60 + 45) * 60_000, unit: 'ms', ts: now }],
				['d', { val: now + (24 * 60 + 4 * 60) * 60_000, unit: 'ms', ts: now }],
				['past', { val: now - 10_000, unit: 'ms', ts: now }],
			]);
			const msg = createMessage({
				title: '{{m.a|durationUntil}}/{{m.b|durationUntil}}/{{m.c|durationUntil}}/{{m.d|durationUntil}}/{{m.past|durationUntil}}',
				metrics,
			});

			const out = renderer.renderMessage(msg);
			expect(out.title).to.equal('56s/34m/3:45h/1d 4h/');
		} finally {
			Date.now = originalNow;
		}
	});

	it('renders raw metric values without units', () => {
		const renderer = createRenderer({ locale });
		const metrics = buildMetrics([['temperature', { val: 21.75, unit: 'C', ts: Date.UTC(2025, 0, 6) }]]);
		const msg = createMessage({ title: '{{m.temperature|raw}}', metrics });

		const out = renderer.renderMessage(msg);

		expect(out.title).to.equal('21.75');
	});

	it('renders timing fields with the t prefix', () => {
		const renderer = createRenderer({ locale });
		const ts = Date.UTC(2025, 0, 7, 9, 30, 0);
		const msg = createMessage({ title: '{{t.createdAt|datetime}}', timing: { createdAt: ts } });

		const out = renderer.renderMessage(msg);
		const df = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

		expect(out.title).to.equal(df.format(new Date(ts)));
	});

	it('renders raw timing fields without formatting', () => {
		const renderer = createRenderer({ locale });
		const ts = Date.UTC(2025, 0, 8, 12, 0, 0);
		const msg = createMessage({ title: '{{t.createdAt|raw}}', timing: { createdAt: ts } });

		const out = renderer.renderMessage(msg);

		expect(out.title).to.equal(String(ts));
	});

	it('applies bool filter with custom labels', () => {
		const renderer = createRenderer({ locale });
		const metrics = buildMetrics([
			['flag', { val: true, unit: 'bool', ts: Date.UTC(2025, 0, 6) }],
			['flag2', { val: false, unit: 'bool', ts: Date.UTC(2025, 0, 6) }],
		]);
		const msg = createMessage({ title: '{{m.flag|bool:yes/no}}/{{m.flag2|bool:on/off}}', metrics });

		const out = renderer.renderMessage(msg);

		expect(out.title).to.equal('yes/off');
	});

	it('applies default filter to missing or empty values', () => {
		const renderer = createRenderer({ locale });
		const metrics = buildMetrics([['empty', { val: null, unit: 'C', ts: Date.UTC(2025, 0, 7) }]]);
		const msg = createMessage({ title: '{{m.missing|default:--}}/{{m.empty.val|default:--}}/{{m.empty|default:--}}', metrics });

		const out = renderer.renderMessage(msg);

		expect(out.title).to.equal('--/--/--');
	});

	it('keeps values unchanged for unknown filters', () => {
		const renderer = createRenderer({ locale });
		const metrics = buildMetrics([['temperature', { val: 21.75, unit: 'C', ts: Date.UTC(2025, 0, 8) }]]);
		const msg = createMessage({ title: '{{m.temperature|noop}}', metrics });

		const out = renderer.renderMessage(msg);
		const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });

		expect(out.title).to.equal(`${nf.format(21.75)} C`);
	});

	it('returns non-template inputs unchanged', () => {
		const renderer = createRenderer({ locale });

		expect(renderer.renderTemplate(123)).to.equal(123);
		expect(renderer.renderTemplate('plain text')).to.equal('plain text');
	});

	it('renders details fields and preserves the original message', () => {
		const renderer = createRenderer({ locale });
		const metrics = buildMetrics([
			['room', { val: 'Kitchen', unit: 'state', ts: Date.UTC(2025, 0, 9) }],
			['task', { val: 'Filter', unit: 'state', ts: Date.UTC(2025, 0, 9) }],
			['tool', { val: 'Brush', unit: 'state', ts: Date.UTC(2025, 0, 9) }],
			['cons', { val: 'Soap', unit: 'state', ts: Date.UTC(2025, 0, 9) }],
		]);
		const details = {
			location: 'Room {{m.room.val}}',
			task: 'Do {{m.task.val}}',
			reason: 'Because {{m.task.val}}',
			tools: ['Use {{m.tool.val}}', 123],
			consumables: ['Add {{m.cons.val}}'],
		};
		const msg = createMessage({ title: 'Title', text: 'Text', details, metrics });

		const out = renderer.renderMessage(msg);

		expect(out.details.location).to.equal('Room Kitchen');
		expect(out.details.task).to.equal('Do Filter');
		expect(out.details.reason).to.equal('Because Filter');
		expect(out.details.tools).to.deep.equal(['Use Brush', 123]);
		expect(out.details.consumables).to.deep.equal(['Add Soap']);

		expect(msg.details.location).to.equal('Room {{m.room.val}}');
		expect(msg.details.tools).to.deep.equal(['Use {{m.tool.val}}', 123]);
	});

	it('renders details placeholders with the d prefix', () => {
		const renderer = createRenderer({ locale });
		const msg = createMessage({
			title: 'At {{d.location}}: {{d.task}} ({{d.tools}} / {{d.consumables}})',
			details: {
				location: 'Kitchen',
				task: 'Clean',
				tools: ['Brush', 'Soap', 123, null],
				consumables: ['Filter'],
			},
		});

		const out = renderer.renderMessage(msg);

		expect(out.title).to.equal('At Kitchen: Clean (Brush, Soap, 123 / Filter)');
	});

	it('renders multiple placeholders in one string', () => {
		const renderer = createRenderer({ locale });
		const metrics = buildMetrics([
			['a', { val: 1, unit: 'u', ts: Date.UTC(2025, 0, 10) }],
			['b', { val: 2, unit: 'u', ts: Date.UTC(2025, 0, 10) }],
		]);
		const msg = createMessage({ title: 'A{{m.a.val}}-B{{m.b.val}}', metrics });

		const out = renderer.renderMessage(msg);

		expect(out.title).to.equal('A1-B2');
	});

	it('renders a list of messages via renderMessages', () => {
		const renderer = createRenderer({ locale });
		const metrics = buildMetrics([
			['temperature', { val: 21.75, unit: 'C', ts: Date.UTC(2025, 0, 1) }],
			['humidity', { val: 46.234, unit: '%', ts: Date.UTC(2025, 0, 3) }],
		]);

		const list = renderer.renderMessages(
			[
				createMessage({ title: 'Temp {{m.temperature}}', metrics }),
				createMessage({ title: '{{m.humidity.val|num:1}}', metrics }),
			],
			{ locale },
		);

		expect(list).to.have.length(2);
		expect(list[0].title).to.include('Temp');
		expect(list[0]).to.not.have.property('display');
		expect(list[1]).to.not.have.property('display');
	});
});
