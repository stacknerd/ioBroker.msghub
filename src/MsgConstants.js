/**
 * MsgConstants
 *
 * Docs: ../docs/modules/MsgConstants.md
 *
 * Centralized enum-like constants for the MsgHub `Message` schema.
 * These values define the allowed identifiers for message classification (`level`, `kind`),
 * provenance (`origin.type`), and supported auxiliary sections (`attachments.type`, `actions.type`).
 *
 * Purpose:
 * - Provide a single source of truth for all fixed string/number literals used across the codebase
 *   (parsing/import, validation, storage, UI rendering, and action handling).
 * - Prevent typos and drift between producers and consumers by using shared constants instead of
 *   repeating inline literals.
 * - Keep the schema stable and explicit: changes to allowed values should happen here and be
 *   reflected throughout the system.
 *
 * Notes:
 * - The object is deeply frozen via `Object.freeze()` to make it effectively immutable at runtime.
 * - `level` uses numeric severities to allow simple comparisons/sorting (none < notice < warning < error).
 * - `kind` and the various `type` fields use stable string identifiers intended for storage/transport.
 */
const MsgConstants = Object.freeze({
	level: Object.freeze({ none: 0, notice: 10, warning: 20, error: 30 }),
	kind: Object.freeze({
		task: 'task',
		status: 'status',
		appointment: 'appointment',
		shoppinglist: 'shoppinglist',
		inventorylist: 'inventorylist',
	}),
	origin: Object.freeze({ type: { manual: 'manual', import: 'import', automation: 'automation' } }),
	attachments: Object.freeze({ type: { ssml: 'ssml', image: 'image', video: 'video', file: 'file' } }),
	actions: Object.freeze({
		type: {
			ack: 'ack',
			delete: 'delete',
			close: 'close',
			open: 'open',
			link: 'link',
			custom: 'custom',
			snooze: 'snooze',
		},
	}),
	lifecycle: Object.freeze({
		state: Object.freeze({
			open: 'open',
			acked: 'acked',
			closed: 'closed',
			snoozed: 'snoozed',
			deleted: 'deleted',
			expired: 'expired',
		}),
	}),
	notfication: Object.freeze({
		events: Object.freeze({
			added: 'added',
			due: 'due',
			update: 'updated',
			deleted: 'deleted',
			expired: 'expired',
		}),
	}),
});
module.exports = { MsgConstants };
