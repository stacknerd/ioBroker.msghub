# Public Web Host (`web.js`)

This document explains the architectural role of Message Hub's public web host in [`/web.js`](/home/pi/ioBroker.msghub/web.js).

It is intentionally not a browser-side document and not a pure IO-runtime class document.
`web.js` sits exactly on the boundary where the ioBroker `web` adapter hosts a Message Hub surface under a public URL.

## What `web.js` is

`web.js` is the **public host entry** for path-based Message Hub web apps.

Its job is to make URLs like:

- `/MessageHub/<instance>/<panelId>/`
- `/MessageHub/<instance>/icons/...`

work through the ioBroker `web` adapter.

That means `web.js` owns:

- route parsing for the public host
- `404` behavior for blocked or unknown public paths
- delivery of icon assets under `/MessageHub/<instance>/icons/...` backed by `admin/icons/**`
- the narrow public admin asset cut under the panel route
- shell delivery based on `admin/tab.html`
- server-side bootstrap forwarding into the reused shell
- no server-side manifest generation

In short:

- `web.js` is a **host**
- not a second frontend
- not a local MsgHub runtime
- and not a new plugin resolver

## What `web.js` is not

`web.js` does **not** own the Message Hub runtime truth.

It does not:

- construct a local `IoUiCatalog`
- construct a local `IoPlugins`
- construct a local `IoPluginPanelResolver`
- discover plugins on its own
- define a second UI truth beside the running MsgHub adapter
- expose the generic `web.*` browser API surface

This is the important architectural line:

- the **running MsgHub adapter** remains the owner of runtime truth
- the **ioBroker `web` adapter** only hosts the public route
- `web.js` bridges between the two

## Where this code “lives”

Physically, the code lives in the repository root as [`/web.js`](/home/pi/ioBroker.msghub/web.js).

That is deliberate for the current architecture:

- the file is loaded by `common.webExtension`
- it runs inside the **ioBroker `web` adapter context**
- not inside the normal `main.js` runtime of the Message Hub adapter

Because of that, `web.js` should not be read like a classic `lib/Io*` runtime class.

It belongs conceptually to the **public host boundary**:

- close enough to the runtime to consume internal adapter bridges
- but not itself part of the MsgHub adapter's internal runtime composition

So the correct mental model is:

- `main.js` = Message Hub adapter runtime/composition root
- `web.js` = public web host entry running in the `web` adapter

## What `web.js` has to do with the MsgHub adapter

Even though it runs in the `web` adapter, `web.js` still depends on the Message Hub adapter for runtime truth.

It needs that adapter for one thing:

1. **App resolution**
   - Which panel app does `<panelId>` refer to?
   - Is it currently resolvable?
   - Which app metadata and resolved icon slots belong to it?

`web.js` therefore depends on narrow internal bridges into the running MsgHub adapter, not on local reconstruction of runtime state.

## What `web.js` does not have to do with the MsgHub adapter

`web.js` is not allowed to treat the MsgHub adapter as a generic dump of internals.

It does not:

- call arbitrary plugin code
- read plugin package structure directly
- rebuild runtime wiring locally
- use `web.*` commands against its own host path
- participate in admin/config token flows

The relationship is deliberately narrow:

- `web.js` asks for a small amount of runtime truth
- the MsgHub adapter answers through explicit internal bridges
- the host turns that into public-web output

## The key interfaces

### Interface 1: ioBroker `webExtension` entry

The ioBroker `web` adapter loads the exported entry from [`/web.js`](/home/pi/ioBroker.msghub/web.js).

That entry receives:

- the running `web` adapter instance
- the current Message Hub instance object
- the Express app owned by the `web` adapter

From there, `web.js` installs one middleware for the public Message Hub mount.

### Interface 2: internal app-resolution bridge

For panel eligibility and app metadata, `web.js` talks to the running MsgHub adapter through:

- `internal.uiCatalog.getApp`

This bridge is owned by `main.js` and proxies to the shared runtime `IoUiCatalog`.

`web.js` does not know how the runtime derives the answer.
It only knows:

- request: `{ mode: 'panel', targetId }`
- response: app record or `null`

### Interface 3: reused shell contract

`web.js` reuses `admin/tab.html` as shell substance.

It does not expose that file as a public URL contract under `MessageHub`, but it does reuse it internally as the shell basis.

For the reused shell to boot correctly, `web.js` forwards host-owned runtime args through the server-rendered marker:

- `msghub-forwarded-args`

The browser runtime then consumes those forwarded args together with the public query args through one shared normalization path.
For the public Web host, that forwarded marker now includes `transport=http`.
`web.js` does not inject a large runtime override script anymore; `admin/tab/runtime.js` derives the HTTP query endpoint itself from the shell base URI.

## Transport contract

The public host and the Admin Tab share one browser runtime, but they boot with different host-owned transport args:

- Admin Tab: `transport=socket`
- Web Extension: `transport=http`

The forwarded transport arg is host-only glue. It is consumed in `admin/tab/runtime.js` and is not itself a public query contract.

For HTTP mode, the host exposes one bridge endpoint:

- `POST /MessageHub/<instance>/query`
- request body: `{ "cmd": "<command>", "payload": { ... } }`
- allowed commands: `ui.bootstrap`, `ui.*`, `web.*`

Defense in depth:

- invalid JSON payloads return `400`
- disallowed commands return `403`
- `ui.bootstrap` responses are filtered by the host to `capabilities.web` before they reach the browser runtime
- the reused shell runs one HTTP-mode socket exposure probe during bootstrap: if a temporary socket/sendTo
  path can still execute `web.ping` successfully in the public host, the UI raises a persistent danger toast
  because the HTTP-only boundary is no longer exclusive

### Interface 4: public route contract

`web.js` owns the public URL contract itself:

- path parsing
- exact icon asset delivery under `/MessageHub/<instance>/icons/...`
- blocked-path behavior
- reuse of `admin/tab.html` without exposing `/manifest.webmanifest` under the public host

This host contract belongs to the public host, not to `IoUiCatalog`, `IoPlugins`, or the browser runtime.

## One host, not a second UI truth

The most important architectural principle is:

`web.js` is only the **host boundary**.

It must not become:

- a second UI registry
- a second plugin resolver
- a second runtime bootstrap world
- or a second source of truth for app metadata

The host may:

- ask the runtime for the truth
- shape public URLs and public responses
- inject host-owned bootstrap glue into the reused shell

The host may not:

- own the runtime truth itself

That distinction is what keeps the public web path architecture-compatible with the rest of Message Hub.
