# MsgAi (Message Hub)

`MsgAi` is a core service that provides **AI-backed data enhancement** to plugins via `ctx.api.ai.*`.

Design intent:

- Plugins own prompt design (they provide `messages[]` and desired output shape).
- The core owns provider configuration and secrets (API keys), and applies cross-cutting policies consistently.
- `MsgAi` never mutates `MsgStore`; it only returns results to the caller (plugins decide what to do with them).

---

## Where it sits in the system

`MsgAi` is instantiated by the adapter (`main.js`) and passed into the core (`MsgStore`), which exposes it to plugin hosts
(`MsgIngest` / `MsgNotify`) via `src/MsgHostApi.js`.

`IoPlugins` binds per-plugin identity into `ctx.api.ai` at call time, so `MsgAi` can apply per-plugin rate limits and
partition caches.

High-level flow:

```
Plugin (lib/*)
  -> ctx.api.ai.text/json(...)
     -> MsgAi (src/MsgAi.js)
        -> OpenAI HTTP API (chat completions)
  -> plugin uses result (deliver / store patch / action)
```

---

## Core responsibilities

1. Provide a stable, capability-based AI API for plugins (`ctx.api.ai`).
2. Keep secrets out of plugins (provider keys live in adapter instance config).
3. Apply cross-cutting concerns:
   - timeouts (AbortController)
   - concurrency limiting (global)
   - rate limiting (per plugin registration id)
   - optional caching (caller-provided cache keys + TTL)
   - structured errors (never throw/reject to plugins)

---

## Current provider support (v1)

`MsgAi` currently supports:

- Provider: `openai`
- Endpoint: `POST /v1/chat/completions`
- JSON mode: uses `response_format: { type: "json_object" }` and parses the returned `message.content`

---

## Adapter configuration

Configured via instance settings (Admin → adapter config). Relevant keys in `io-package.json` native:

- `aiEnabled` (boolean)
- `aiProvider` (`"openai"`)
- `aiOpenAiApiKey` (encrypted native; decrypted in `main.js`)
- `aiOpenAiBaseUrl` (default: `https://api.openai.com/v1`)
- `aiOpenAiModel` (fallback model, default: `gpt-4o-mini`)
- `aiOpenAiModelFast` / `aiOpenAiModelBalanced` / `aiOpenAiModelBest` (profile models; used for `hints.quality`)
- `aiPurposeModelOverrides` (JSON array; purpose-based model overrides)
- `aiTimeoutMs` (default request timeout)
- `aiMaxConcurrency` (global)
- `aiRpm` (requests per minute **per plugin**, `0 = unlimited`)
- `aiCacheTtlMs` (default TTL for request caching, `0 = off`)

### Admin: "Test AI"

The instance config UI includes an **AI test** helper to validate connectivity and model selection without writing any
messages.

- It runs `admin.ai.test` via `sendTo` and returns the result into a disabled textbox (`aiTestLastResult`).
- The test uses the **current form values** (including the key you typed) and does not require an adapter restart.
- `aiTest*` fields are `doNotSave` (they are not persisted to `native`).

### Model selection rules (v1)

Model selection is decided by the core, based on:

1. `aiPurposeModelOverrides` (purpose+quality, then purpose-only)
2. `aiOpenAiModelFast|Balanced|Best` (selected by `hints.quality`)
3. `aiOpenAiModel` fallback

### `aiPurposeModelOverrides` (how to use it)

This field is a **JSON array string** configured in the adapter instance config (Admin UI).

Each entry has this shape:

```json
{ "purpose": "ssml", "quality": "best", "model": "gpt-4o-mini" }
```

Rules:

- `purpose` is required and should match what plugins send in `request.purpose` (case-insensitive).
- `quality` is optional:
  - If present, it must be one of `fast|balanced|best`.
  - If omitted, the entry applies to **all qualities** for that purpose.
- `model` is required (OpenAI model string).
- Precedence is:
  1) exact match: `(purpose + quality)`
  2) fallback match: `(purpose only)`
  3) profile model by `hints.quality`
  4) `aiOpenAiModel` fallback

Examples:

```json
[
  { "purpose": "ssml", "quality": "best", "model": "gpt-4o-mini" },
  { "purpose": "categorize", "model": "gpt-4o-mini" }
]
```

Operational notes:

- Invalid JSON is treated as `[]` and logged as a warning during adapter startup.
- Prefer short, stable purposes (e.g. `ssml`, `categorize`, `motivation.summary`) so overrides remain readable.

---

## Plugin-facing API (`ctx.api.ai`)

Availability:

- `ctx.api.ai` may be `null` when MsgAi is not wired.
- When present, it is best-effort: it never throws and never returns a rejecting Promise.

### `getStatus()`

Returns a small status object:

- `{ enabled: true, provider: 'openai' }` when fully configured
- `{ enabled: false, provider?, reason }` when disabled/misconfigured

Plugins should use this to skip optional enhancement work.

### `text(request)`

Request free-form text output (SSML, summaries, rewritten text, ...).

### `json(request)`

Request JSON output (categorization, extraction, ...).
If the provider returns invalid JSON, `MsgAi` returns `{ ok:false, error: { code:'BAD_JSON', ... } }`.

### Request shape (v1)

- `purpose` (string, required): short label for logging/metrics (e.g. `'ssml'`, `'categorize'`)
- `messages` (array, required): `{ role: 'system'|'user'|'assistant', content: string }[]`
- `hints` (optional): `{ quality?: 'fast'|'balanced'|'best', temperature?: number, maxTokens?: number }`
- `timeoutMs` (optional number)
- `cache` (optional): `{ key: string, ttlMs?: number }`

### Result shape (v1)

```js
// ok path:
{ ok: true, value, meta }

// error path:
{ ok: false, error: { code, message }, meta? }
```

Common error codes:

- `NOT_CONFIGURED` (disabled/missing key/unsupported provider)
- `BAD_REQUEST` (missing purpose/messages)
- `TIMEOUT`
- `RATE_LIMITED`
- `PROVIDER_ERROR`
- `BAD_JSON` (json() only)

---

## Related files

- Implementation: `src/MsgAi.js`
- Plugin API builder: `src/MsgHostApi.js`
- Adapter wiring: `main.js`
- Plugin developer guide: `docs/plugins/README.md`
