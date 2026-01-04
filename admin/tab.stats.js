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
				...kinds.map(([kind, v]) => {
					const bucket = isObject(v) ? v : {};
					return h('div', { class: 'msghub-stats-block' }, [
						h('div', { class: 'msghub-muted msghub-stats-subtitle', text: kind }),
						h('div', { class: 'msghub-stats-grid' }, [
							renderTile(h, 'total', String(bucket.total ?? 0)),
							renderTile(h, 'overdue', String(bucket.overdue ?? 0)),
							renderTile(h, 'today', String(bucket.today ?? 0)),
							renderTile(h, 'tomorrow', String(bucket.tomorrow ?? 0)),
							renderTile(h, 'next7Days', String(bucket.next7Days ?? 0)),
							renderTile(h, 'thisWeek', String(bucket.thisWeek ?? 0)),
							renderTile(h, 'thisMonth', String(bucket.thisMonth ?? 0)),
						]),
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

			const currentByKind = renderKeyValueTiles(h, 'Current by kind', current.byKind);
			if (currentByKind) {
				root.appendChild(currentByKind);
			}

			const currentByLifecycle = renderKeyValueTiles(h, 'Current by lifecycle', current.byLifecycle);
			if (currentByLifecycle) {
				root.appendChild(currentByLifecycle);
			}

			root.appendChild(
				h('div', { class: 'card' }, [
					h('div', { class: 'card-content' }, [
						h('div', { class: 'card-title', text: 'Schedule (domain “fällig”)' }),
						h('div', { class: 'msghub-stats-grid' }, [
							renderTile(h, 'total', String(schedule.total ?? 0)),
							renderTile(h, 'overdue', String(schedule.overdue ?? 0)),
							renderTile(h, 'today', String(schedule.today ?? 0)),
							renderTile(h, 'tomorrow', String(schedule.tomorrow ?? 0)),
							renderTile(h, 'next7Days', String(schedule.next7Days ?? 0)),
							renderTile(h, 'thisWeek', String(schedule.thisWeek ?? 0)),
							renderTile(h, 'thisMonth', String(schedule.thisMonth ?? 0)),
						]),
					]),
				]),
			);

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
