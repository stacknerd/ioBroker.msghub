# admin/tab/scroll-strip.js: shared horizontal overflow strip for tabs and compact toolbars

`scroll-strip.js` provides the small shell-side helper that turns a compact horizontal host
into a managed scroll strip with fade-based overflow affordances.
It is intentionally narrow: the module does not own tab semantics, toolbar actions, or any
panel-specific data. Its only job is to wrap existing host content into a scrollable viewport,
append left/right edge containers, and keep overflow state classes in sync with the real
scroll position and content width.

The helper is used for two shell families that should feel alike on narrow screens:

- the main tab navigation
- compact panel toolbars

The result is the shared `window.MsghubScrollStrip` facade.

---

## Where it sits in the system

The module is loaded from [`admin/tab.html`](../../admin/tab.html) after [`./tab-ui.md`](./tab-ui.md)
and before [`./tab-layout.md`](./tab-layout.md).

That order matters:

- `layout.js` needs the helper when it builds the tab navigation
- panel renderers can call it later for their own toolbars
- the helper itself stays shell-only and does not depend on panel state modules

Its visual base lives in [`admin/tab/strip.css`](../../admin/tab/strip.css), which is composed
into the shared stylesheet entry [`admin/tab.css`](../../admin/tab.css).
Context-specific fade colors are still assigned by the concrete host styles in
[`admin/tab/layout.css`](../../admin/tab/layout.css) and
[`admin/tab/toolbar.css`](../../admin/tab/toolbar.css).

The current native callers are:

- [`admin/tab/layout.js`](../../admin/tab/layout.js) for `nav.msghub-tabs`
- [`admin/tab/panels/messages/render.meta.js`](../../admin/tab/panels/messages/render.meta.js)
  for the messages toolbar
- [`admin/tab/panels/plugins/render.catalog.js`](../../admin/tab/panels/plugins/render.catalog.js)
  for the plugins add-toolbar

---

## Responsibilities

### 1) Normalize the host into one scroll-strip structure

`initStrip(hostEl)` mutates the given host in place.
It takes the host's existing children, moves them into a new inner viewport, and appends two
edge containers that act as persistent styling hooks for overflow hints.

This keeps the outer host as the visual shell with its existing padding, border, background,
and component-specific classes, while the new inner viewport becomes the actual horizontal
scroll surface.

### 2) Keep overflow state classes in sync

The helper maintains these host-level state classes:

- `has-overflow-left`
- `has-overflow-right`

Those classes drive the fade visibility in [`admin/tab/strip.css`](../../admin/tab/strip.css).
They are updated from:

- viewport scroll events
- `ResizeObserver` on the viewport
- `MutationObserver` on the viewport subtree

That combination is deliberate:

- scrolling changes the visible edge state directly
- viewport resize changes available width
- subtree mutations cover content-width changes such as updated button labels or paging text

### 3) Expose a minimal lifecycle handle

The helper returns a small handle so callers can access the viewport and tear down observers
when needed.

The public shape is:

```js
{
	(viewport, disconnect);
}
```

Current shell callers mainly need the initialization side.
`disconnect()` exists so the helper remains a well-behaved reusable utility instead of a
fire-and-forget DOM mutation with no cleanup path.

---

## Public surface / integration points

### `window.MsghubScrollStrip`

The module exposes one frozen global facade:

```js
window.MsghubScrollStrip = Object.freeze({
	initStrip,
});
```

### `initStrip(hostEl)`

Initializes one host element as a scroll strip and returns:

```js
{
  viewport,
  disconnect,
}
```

`viewport` is the generated `.msghub-strip-viewport` element.
`disconnect()` removes the helper's observers and event listeners.

For invalid input, the helper must not crash.
For already initialized hosts, it must not wrap a second time.

---

## DOM shape after initialization

Given a host such as:

```html
<nav class="msghub-tabs">...</nav>
```

`initStrip(hostEl)` normalizes it to:

```html
<nav class="msghub-tabs msghub-strip-host">
	<div class="msghub-strip-viewport">
		<!-- previous host children moved here -->
	</div>
	<span
		class="msghub-strip-edge msghub-strip-edge--left"
		aria-hidden="true"
	></span>
	<span
		class="msghub-strip-edge msghub-strip-edge--right"
		aria-hidden="true"
	></span>
</nav>
```

Important consequences:

- the host element stays the integration anchor for the caller
- existing host classes remain on the host
- only the host's child structure changes
- selectors such as `.msghub-tab` still work because the original content remains in the host subtree

For toolbars this means existing references like `toolbarEl` stay valid even though the buttons
move one level deeper into the generated viewport.

---

## Idempotence / lifecycle behavior

`initStrip(hostEl)` is explicitly idempotent.

If the host already carries `.msghub-strip-host`, the helper must not:

- create a second viewport
- append duplicate edge containers
- register duplicate observers
- move children again

Instead, it returns the existing handle when known, or a safe no-op style handle if the host is
already marked as a strip but no stored handle is available in the current module context.

This class-first guard is important because the DOM marker is the visible truth of the host state,
while the internal handle cache is only module-local bookkeeping.

---

## Design notes / invariants

- `scroll-strip.js` is a shell utility, not a panel abstraction. It owns structure and overflow state, not business behavior.
- The host remains responsible for its own look. `scroll-strip.js` only adds the generic strip wrapper and state classes.
- Fade appearance is intentionally CSS-driven. The edge containers are structural extension points for later visuals such as arrows or hover affordances.
- The helper does not auto-scroll active tabs into view in v1.
- The helper does not own wheel-to-horizontal forwarding in v1.
- The helper is intentionally reused only for tabs and compact toolbars; table overflow remains a separate pattern.
- Overflow truth is derived from the viewport's `scrollWidth`, `clientWidth`, and `scrollLeft`, not from viewport size alone.
- Mutation observation is required because text changes can alter the scrollable width without resizing the viewport box itself.

---

## Related files

- Implementation: [`admin/tab/scroll-strip.js`](../../admin/tab/scroll-strip.js)
- Test: [`admin/tab/scroll-strip.test.js`](../../admin/tab/scroll-strip.test.js)
- Shared strip CSS: [`admin/tab/strip.css`](../../admin/tab/strip.css)
- CSS entrypoint: [`admin/tab.css`](../../admin/tab.css)
- HTML script load order: [`admin/tab.html`](../../admin/tab.html)
- Tab host integration: [`./tab-layout.md`](./tab-layout.md)
- Shared toolbar styling: [`admin/tab/toolbar.css`](../../admin/tab/toolbar.css)
- Messages toolbar caller: [`./tab-panels-messages-render.meta.md`](./tab-panels-messages-render.meta.md)
- Plugins toolbar caller: [`./tab-panels-plugins-render.catalog.md`](./tab-panels-plugins-render.catalog.md)
