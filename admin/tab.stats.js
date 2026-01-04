/* global window */
'use strict';

(function () {
	const win = /** @type {any} */ (window);

	function isObject(v) {
		return !!v && typeof v === 'object' && !Array.isArray(v);
	}

	function formatTs(ts) {
		if (typeof ts !== 'number' || !Number.isFinite(ts)) {
			return 'n/a';
		}
		try {
			return new Date(ts).toLocaleString();
		} catch (_err) {
			return String(ts);
		}
	}

	function formatBytes(bytes) {
		if (typeof bytes !== 'number' || !Number.isFinite(bytes)) {
			return 'n/a';
		}
		const kb = 1024;
		const mb = kb * 1024;
		const gb = mb * 1024;
		if (bytes >= gb) {
			return `${(bytes / gb).toFixed(2)} GB`;
		}
		if (bytes >= mb) {
			return `${(bytes / mb).toFixed(2)} MB`;
		}
		if (bytes >= kb) {
			return `${(bytes / kb).toFixed(1)} KB`;
		}
		return `${bytes} B`;
	}

	function renderTile(h, label, value) {
		return h('div', { class: 'msghub-stat-tile' }, [
			h('div', { class: 'msghub-stat-label', text: label }),
			h('div', { class: 'msghub-stat-value', text: value }),
		]);
	}

	function renderKeyValueTiles(h, title, obj) {
		const entries = Object.entries(isObject(obj) ? obj : {}).sort(([a], [b]) => String(a).localeCompare(String(b)));
		if (entries.length === 0) {
			return null;
		}
		return h('div', { class: 'card' }, [
			h('div', { class: 'card-content' }, [
				h('div', { class: 'card-title', text: title }),
				h(
					'div',
					{ class: 'msghub-stats-grid' },
					entries.map(([k, v]) => renderTile(h, k, typeof v === 'number' ? String(v) : String(v))),
				),
			]),
		]);
	}

	function clamp01(n) {
		const x = typeof n === 'number' && Number.isFinite(n) ? n : 0;
		if (x < 0) {
			return 0;
		}
		if (x > 1) {
			return 1;
		}
		return x;
	}

	function renderLegend(h, entries) {
		return h(
			'div',
			{ class: 'msghub-legend' },
			(entries || []).map(e =>
				h('div', { class: 'msghub-legend-item' }, [
					h('span', { class: 'msghub-legend-dot', style: `background:${e.color}` }),
					h('span', { class: 'msghub-legend-label', text: e.label }),
					h('span', { class: 'msghub-legend-value msghub-muted', text: e.value }),
				]),
			),
		);
	}

	function renderRingCard(h, title, obj) {
		const entriesRaw = Object.entries(isObject(obj) ? obj : {})
			.map(([k, v]) => ({
				label: String(k),
				value: typeof v === 'number' && Number.isFinite(v) ? v : 0,
			}))
			.filter(e => e.value > 0)
			.sort((a, b) => b.value - a.value);

		const total = entriesRaw.reduce((sum, e) => sum + e.value, 0);

		const palette = ['#26a69a', '#42a5f5', '#ab47bc', '#ffa726', '#ef5350', '#8d6e63', '#26c6da'];
		const segments = entriesRaw.map((e, idx) => ({
			label: e.label,
			value: e.value,
			color: palette[idx % palette.length],
		}));

		let angle = 0;
		const stops = segments.map(s => {
			const pct = total > 0 ? s.value / total : 0;
			const start = angle * 360;
			angle += pct;
			const end = angle * 360;
			return `${s.color} ${start.toFixed(3)}deg ${end.toFixed(3)}deg`;
		});

		const bg = total > 0 ? `conic-gradient(${stops.join(',')})` : 'conic-gradient(#cfd8dc 0deg 360deg)';

		const legendEntries = segments.map(s => ({
			label: s.label,
			color: s.color,
			value: total > 0 ? `${s.value} (${Math.round((s.value / total) * 100)}%)` : String(s.value),
		}));

		return h('div', { class: 'card' }, [
			h('div', { class: 'card-content' }, [
				h('div', { class: 'card-title', text: title }),
				h('div', { class: 'msghub-ring-wrap' }, [
					h('div', { class: 'msghub-ring', style: `background:${bg}` }, [
						h('div', { class: 'msghub-ring-center' }, [
							h('div', { class: 'msghub-ring-total', text: String(total) }),
							h('div', { class: 'msghub-ring-sub msghub-muted', text: 'total' }),
						]),
					]),
					renderLegend(h, legendEntries),
				]),
			]),
		]);
	}

	function renderScheduleBody(h, bucket, { showLegend = false } = {}) {
		const b = isObject(bucket) ? bucket : {};
		const total = typeof b.total === 'number' && Number.isFinite(b.total) ? Math.max(0, b.total) : 0;
		const overdue = typeof b.overdue === 'number' && Number.isFinite(b.overdue) ? Math.max(0, b.overdue) : 0;

		const marker = total > 0 ? clamp01(overdue / total) : 0;

		const pickCount = (obj, key, fallbackKey) => {
			const v = obj && typeof obj === 'object' ? obj[key] : undefined;
			if (typeof v === 'number' && Number.isFinite(v)) {
				return Math.max(0, v);
			}
			const fb = obj && typeof obj === 'object' ? obj[fallbackKey] : undefined;
			return typeof fb === 'number' && Number.isFinite(fb) ? Math.max(0, fb) : 0;
		};

		const mkRow = (key, label, value, color) => {
			const v = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
			const pct = total > 0 ? clamp01(v / total) : 0;
			const w = pct;
			return h('div', { class: 'msghub-sched-row' }, [
				h('div', { class: 'msghub-sched-label msghub-muted', text: label }),
				h('div', {
					class: `msghub-sched-bar is-${key}`,
					style: `--msghub-marker:${marker}; --msghub-bucket:${w}; --msghub-bucket-color:${color};`,
					title: `${label}: ${v} / total ${total} (overdue ${overdue})`,
				}),
				h('div', { class: 'msghub-sched-value msghub-mono', text: String(v) }),
			]);
		};

		const rows = h('div', { class: 'msghub-sched' }, [
			mkRow('today', 'today', pickCount(b, 'today', 'today'), '#26a69a'),
			mkRow('tomorrow', 'tomorrow', pickCount(b, 'tomorrow', 'tomorrow'), '#42a5f5'),
			mkRow('week', 'week', pickCount(b, 'thisWeekFromToday', 'thisWeek'), '#ab47bc'),
			mkRow('month', 'month', pickCount(b, 'thisMonthFromToday', 'thisMonth'), '#ffa726'),
		]);

		const out = [rows];
		if (showLegend) {
			out.push(
				h('div', { class: 'msghub-sched-legend' }, [
					renderLegend(h, [
						{ label: 'overdue', color: 'var(--msghub-danger)', value: String(overdue) },
						{ label: 'today marker', color: 'var(--msghub-text)', value: '|' },
						{ label: 'filler', color: 'var(--msghub-border)', value: '' },
					]),
				]),
			);
		}

		return { total, overdue, node: h('div', { class: 'msghub-sched-wrap' }, out) };
	}

	function renderScheduleChart(h, title, bucket) {
		const { total, node } = renderScheduleBody(h, bucket, { showLegend: true });
		return h('div', { class: 'card' }, [
			h('div', { class: 'card-content' }, [
				h('div', { class: 'card-title', text: title }),
				h('div', { class: 'msghub-sched-meta msghub-muted', text: `total: ${total}` }),
				node,
			]),
		]);
	}

	function renderScheduleByKind(h, schedule) {
		const byKind = schedule && typeof schedule === 'object' ? schedule.byKind : null;
		if (!isObject(byKind)) {
			return null;
		}
		const kinds = Object.entries(byKind).sort(([a], [b]) => String(a).localeCompare(String(b)));
		if (kinds.length === 0) {
			return null;
		}

		return h('div', { class: 'card' }, [
			h('div', { class: 'card-content' }, [
				h('div', { class: 'card-title', text: 'Schedule by kind' }),
				h('div', { class: 'msghub-sched-legend' }, [
					renderLegend(h, [
						{ label: 'overdue', color: 'var(--msghub-danger)', value: '' },
						{ label: 'today marker', color: 'var(--msghub-text)', value: '|' },
						{ label: 'filler', color: 'var(--msghub-border)', value: '' },
					]),
				]),
				...kinds.map(([kind, v]) => {
					const bucket = isObject(v) ? v : {};
					const { total, node } = renderScheduleBody(h, bucket, { showLegend: false });
					return h('div', { class: 'msghub-stats-block' }, [
						h('div', { class: 'msghub-muted msghub-stats-subtitle', text: `${kind} (total ${total})` }),
						node,
					]);
				}),
			]),
		]);
	}

	function renderDoneByKind(h, doneBucket) {
		const byKind = doneBucket && typeof doneBucket === 'object' ? doneBucket.byKind : null;
		if (!isObject(byKind)) {
			return null;
		}
		const entries = Object.entries(byKind).sort(([a], [b]) => String(a).localeCompare(String(b)));
		if (entries.length === 0) {
			return null;
		}
		return h(
			'div',
			{ class: 'msghub-stats-grid' },
			entries.map(([k, v]) => renderTile(h, k, typeof v === 'number' ? String(v) : String(v))),
		);
	}

	function initStatsSection(ctx) {
		const { sendTo, h, M, elements } = ctx;
		const root = elements.statsRoot;
		if (!root) {
			throw new Error('MsghubAdminTabStats: missing statsRoot element');
		}

		let loading = false;
		let lastError = null;
		let lastStats = null;

		const toast = message => {
			try {
				M.toast({ html: String(message) });
			} catch (_err) {
				// ignore
			}
		};

		function render() {
			root.innerHTML = '';

			const actions = h('div', { class: 'msghub-actions' }, [
				h('button', {
					class: 'btn',
					type: 'button',
					disabled: loading ? 'true' : null,
					onclick: () => loadStats({ archiveSize: false }).catch(() => undefined),
					text: 'Refresh',
				}),
			]);

			root.appendChild(actions);

			if (loading) {
				root.appendChild(h('div', { class: 'progress' }, h('div', { class: 'indeterminate' })));
				return;
			}

			if (lastError) {
				root.appendChild(h('div', { class: 'msghub-error', text: String(lastError) }));
				return;
			}

			if (!lastStats) {
				root.appendChild(h('div', { class: 'msghub-muted', text: 'No stats loaded yet.' }));
				return;
			}

			const meta = isObject(lastStats.meta) ? lastStats.meta : {};
			root.appendChild(
				h('div', { class: 'msghub-muted msghub-stats-meta' }, [
					h('div', { text: `generatedAt: ${formatTs(meta.generatedAt)}` }),
					h('div', { text: meta.tz ? `tz: ${meta.tz}` : 'tz: n/a' }),
				]),
			);

			const current = isObject(lastStats.current) ? lastStats.current : {};
			const schedule = isObject(lastStats.schedule) ? lastStats.schedule : {};
			const done = isObject(lastStats.done) ? lastStats.done : {};
			const io = isObject(lastStats.io) ? lastStats.io : {};

			root.appendChild(
				h('div', { class: 'card' }, [
					h('div', { class: 'card-content' }, [
						h('div', { class: 'card-title', text: 'Current' }),
						h('div', { class: 'msghub-stats-grid' }, [
							renderTile(h, 'total', String(current.total ?? 0)),
						]),
					]),
				]),
			);

			const ringRow = h('div', { class: 'msghub-stats-row' }, [
				h('div', { class: 'msghub-stats-col' }, [renderRingCard(h, 'Current by kind', current.byKind)]),
				h('div', { class: 'msghub-stats-col' }, [renderRingCard(h, 'Current by lifecycle', current.byLifecycle)]),
			]);
			root.appendChild(ringRow);

			const scheduleDomain = renderScheduleChart(h, 'Schedule (domain “fällig”)', schedule);
			if (scheduleDomain) {
				root.appendChild(scheduleDomain);
			}

			const scheduleByKind = renderScheduleByKind(h, schedule);
			if (scheduleByKind) {
				root.appendChild(scheduleByKind);
			}

			root.appendChild(
				h('div', { class: 'card' }, [
					h('div', { class: 'card-content' }, [
						h('div', { class: 'card-title', text: 'Done (transition → closed)' }),
						h('div', { class: 'msghub-stats-grid' }, [
							renderTile(h, 'today', String(done?.today?.total ?? 0)),
							renderTile(h, 'thisWeek', String(done?.thisWeek?.total ?? 0)),
							renderTile(h, 'thisMonth', String(done?.thisMonth?.total ?? 0)),
						]),
						done?.lastClosedAt ? h('div', { class: 'msghub-muted msghub-stats-meta', text: `lastClosedAt: ${formatTs(done.lastClosedAt)}` }) : null,
						h('div', { class: 'msghub-stats-block' }, [
							h('div', { class: 'msghub-muted msghub-stats-subtitle', text: 'today by kind' }),
							renderDoneByKind(h, done?.today),
						]),
					]),
				]),
			);

			const storage = isObject(io.storage) ? io.storage : {};
			const archive = isObject(io.archive) ? io.archive : {};
			const pending = isObject(archive.pending) ? archive.pending : {};

			root.appendChild(
				h('div', { class: 'card' }, [
					h('div', { class: 'card-content' }, [
						h('div', { class: 'card-title', text: 'Persistent Storage' }),
						h('div', { class: 'msghub-stats-grid' }, [
							renderTile(h, 'lastPersistedAt', formatTs(storage.lastPersistedAt)),
							renderTile(h, 'lastPersistedBytes', formatBytes(storage.lastPersistedBytes)),
							renderTile(h, 'pending', storage.pending === true ? 'yes' : 'no'),
						]),
					]),
				]),
			);

			root.appendChild(
				h('div', { class: 'card' }, [
					h('div', { class: 'card-content' }, [
						h('div', { class: 'card-title', text: 'Archive' }),
						h('div', { class: 'msghub-actions' }, [
							h('button', {
								class: 'btn-flat',
								type: 'button',
								disabled: loading ? 'true' : null,
								onclick: () => loadStats({ archiveSize: true }).catch(() => undefined),
								text: 'Compute archive size',
							}),
						]),
						h('div', { class: 'msghub-stats-grid' }, [
							renderTile(h, 'keepPreviousWeeks', String(archive.keepPreviousWeeks ?? 0)),
							renderTile(h, 'lastFlushedAt', formatTs(archive.lastFlushedAt)),
							renderTile(h, 'pending.events', String(pending.events ?? 0)),
							renderTile(h, 'pending.refs', String(pending.refs ?? 0)),
							renderTile(h, 'size', formatBytes(archive.approxSizeBytes)),
						]),
						archive.approxSizeUpdatedAt
							? h('div', { class: 'msghub-muted msghub-stats-meta', text: `sizeUpdatedAt: ${formatTs(archive.approxSizeUpdatedAt)}` })
							: null,
						archive.approxSizeIsComplete === false && archive.approxSizeBytes != null
							? h('div', { class: 'msghub-muted msghub-stats-meta', text: 'archive.size is incomplete (backend does not provide file sizes for all entries)' })
							: null,
					]),
				]),
			);
		}

		async function loadStats({ archiveSize }) {
			if (loading) {
				return;
			}
			loading = true;
			lastError = null;
			render();

			try {
				lastStats = await sendTo('admin.stats.get', {
					include: {
						archiveSize: archiveSize === true,
						archiveSizeMaxAgeMs: 10 * 60 * 1000,
					},
				});
			} catch (e) {
				lastError = String(e?.message || e);
				toast(lastError);
			} finally {
				loading = false;
				render();
			}
		}

		render();

		return {
			onConnect: () => loadStats({ archiveSize: false }),
		};
	}

	win.MsghubAdminTabStats = Object.freeze({
		init: initStatsSection,
	});
})();
