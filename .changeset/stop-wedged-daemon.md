---
"agentic-debug-mode": patch
---

`stop` no longer reports success while an alive-but-unresponsive service process survives. After a failed shutdown request it now retries the health probe, verifies the recorded process identity, and terminates the wedged process (graceful, then forced) before reporting stopped.
