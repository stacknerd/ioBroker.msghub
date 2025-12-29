# MsgUtils (Message Hub): shared low-level helpers

`MsgUtils` is a small collection of shared helper functions used by Message Hub’s modules.
It exists to keep those modules focused on their domain logic while centralizing a handful of cross-cutting “plumbing”
tasks (Map-safe JSON, ioBroker file-storage setup, and serialized async I/O).

## Design notes

- Keep utilities small and predictable; no business logic lives here.
- Treat this as an internal helper module (not a user-facing Message Hub API).

---

## Related files

- Implementation: `src/MsgUtils.js`
