const MsgConstants = Object.freeze({
	level: Object.freeze({ none: 0, notice: 10, warning: 20, error: 30 }),
	kind: Object.freeze({ task: 'task', status: 'status', appointment: 'appointment', shoppinglist: 'shoppinglist' }),
	origin: Object.freeze({ type: { manual: 'manual', import: 'import', automation: 'automation' } }),
	attachments: Object.freeze({ type: { ssml: 'ssml', image: 'image', video: 'video', qrcode: 'qr' } }),
	actions: Object.freeze({
		ack: 'ack',
		delete: 'delete',
		close: 'close',
		open: 'open',
		link: 'link',
		custom: 'custom',
	}),
});
module.exports = { MsgConstants };

/**
 * the structure of the main Message-Element:
 *
 *
 * Message {
 *   ref: string                   // interne eindeutige ID (stabil)
 *
 *   // Anzeige
 *   title: string                 // UI-Überschrift (z.B. "Flur")
 *   text: string                  // Freitextbeschreibung
 *
 *   // Klassifikation
 *   level: 0|10|20|30             // none/notice/warning/error
 *   kind: "task"|"status"|"appointment"|"shoppinglist"
 *
 *   origin: {
 *     type: "manual"|"import"|"automation"
 *     system?: string             // z.B. "alexa", "icloud", "dwd"
 *     id?: string                 // externe ID
 *   }
 *
 *   timing: {
 *     createdAt: number
 *     updatedAt?: number
 *     expiresAt?: number | null
 *     notifyAt?: number | null
 *
 *     dueAt?: number | null       // task
 *     startAt?: number | null     // appointment
 *     endAt?: number | null       // appointment
 *   }
 *
 *   // Strukturierte Details (optional; v.a. task/status/appointment)
 *   details?: {
 *     location?: string
 *     task?: string
 *     reason?: string
 *     tools?: string[]
 *     consumables?: string[]
 *   }
 *
 *   // Messwerte (optional)
 *   metrics?: Record<string, number|string|boolean|null>
 *
 *   // Anhänge (optional)
 *   attachments?: Array<{
 *     type: "ssml"|"image"|"video"|"file"
 *     value: string
 *   }>
 *
 *   // Shoppingliste (nur bei kind="shoppinglist")
 *   shoppinglistItems?: Array<{
 *     name: string
 *     category?: string
 *     quantity?: { val: number; unit: string }
 *     checked: boolean
 *   }>
 *
 *   // Aktionen (optional)
 *   actions?: Array<{
 *     type: "ack"|"delete"|"close"|"open"|"link"|"custom"
 * 	 	// Nur “gesehen”: ack
 * 	 	// Wirklich entfernen: delete
 * 	 	// Vorgang abschließen/Alarm schließen: close
 * 	 	// Etwas öffnen/aktivieren: open
 * 	 	// Nur navigieren: link
 * 	 	// Alles andere/Device/Automation: custom
 *
 *     id?: string | null
 *     payload?: Record<string, unknown> | null
 * 	ts?: number
 *   }>
 *
 *   // Progress (optional; v.a. task)
 *   progress?: {
 *     startedAt?: number | null
 *     finishedAt?: number | null
 *     percentage?: number | null
 *   }
 *
 *   dependencies?: string[]
 * }
 *
 *
 */
