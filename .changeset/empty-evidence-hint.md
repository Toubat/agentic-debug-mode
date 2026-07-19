---
"agentic-debug-mode": patch
---

`logs` now emits a `verify-ingest` hint when a session has zero evidence and no diagnostics: an unexecuted path or failed run is one cause, a stale probe endpoint after a service restart is the other — the hint points at `reset`, which prints the current Ingest URL and Append Path.
