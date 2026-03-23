# admin/tab/panels/messages/lifecycle.js: auto-refresh scheduler and visibility bindings

`admin/tab/panels/messages/lifecycle.js` owns the runtime behavior around automatic refreshes in the Messages panel.
It decides when refreshes are allowed, schedules timer-based refresh cycles, and reacts to document visibility and
Admin-tab switches.

In short: this file controls when the Messages panel is allowed to refresh itself.

---

## Where it sits in the system

`index.js` creates the lifecycle controller with the shared state, the panel root element, the UI API, and two refresh
callbacks. It binds the event listeners immediately during panel initialization and calls `scheduleAuto()` from
`onConnect()` after the first data load.

This module sits beside the data/render modules rather than above them. It does not know how to query messages itself.
Instead, it calls the callbacks supplied by `index.js`.

---

## Responsibilities

1. Decide whether auto refresh is currently allowed.
   - `canAutoRefresh()` requires the Messages tab to be visible.
   - It also blocks refreshes while the custom context menu or the large overlay is open.

2. Schedule and stop the auto-refresh timer.
   - `scheduleAuto()` clears any existing timer and, when auto refresh is active and the Messages tab is visible, starts a new timeout. Open context menus and overlays do not prevent the timer from being scheduled. They only block the refresh cycle from running when the timer fires, through `canAutoRefresh()`.
   - `stopAuto()` clears the pending timeout and resets `state.autoTimer`.

3. Bind shell-level events that affect refresh behavior.
   - `visibilitychange`
   - `msghub:tabSwitch`

4. Route the refresh cycle by archive mode.
   - In `follow` mode it runs `onRefreshFollow()`.
   - In `browse` mode it runs `onRefreshBrowsePending()`.

---

## Public surface / integration points

The module exports:

```js
window.MsghubAdminTabMessagesLifecycle = {
  createLifecycle
}
```

`createLifecycle(options)` returns:

```js
{
  scheduleAuto,
  stopAuto,
  bindEvents,
  unbindEvents,
  canAutoRefresh
}
```

Important options:

- `state`
- `root`
- `ui`
- `onRefreshFollow`
- `onRefreshBrowsePending`

`isTabVisible()` is internal. It checks the closest `#tab-messages` element, `document.hidden`, and `offsetParent`.

---

## Design notes / invariants

- Auto refresh is timeout-based, not interval-based. Each cycle reschedules itself after it runs.
- The delay is jittered by up to `1199` ms on top of `state.autoRefreshMs`.
- `scheduleAuto()` does nothing when auto refresh is disabled or the Messages tab is not currently visible.
- Open menus and overlays do not prevent scheduling; they block only the timer callback execution via `canAutoRefresh()`.
- Entering the Messages tab through `msghub:tabSwitch` can trigger an immediate refresh before the next timeout is scheduled.
- Leaving the Messages tab stops the timer.
- `bindEvents()` is idempotent. Repeated calls do not register duplicate listeners.
- `unbindEvents()` is also safe to call repeatedly and always stops the current timer.
- The browse-mode branch already exists in the lifecycle contract, but the current normal UI flow does not activate archive browsing.

---

## Related files

- Implementation: `admin/tab/panels/messages/lifecycle.js`
- Test: `admin/tab/panels/messages/lifecycle.test.js`
- Panel entry: [`./tab-panels-messages-index.md`](./tab-panels-messages-index.md)
- State: [`./tab-panels-messages-state.md`](./tab-panels-messages-state.md)
- Admin frontend overview: `docs/ui/README.md`
