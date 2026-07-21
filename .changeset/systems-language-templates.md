---
"agentic-debug-mode": minor
---

Add probe templates for five more languages — C, C++, Rust, Java, and Kotlin — bringing the
advertised helper/runtime pairs from nine to fourteen (all file ingest). Java and Kotlin build
structured values with at-source redaction; C, C++, and Rust use a lightweight serialized-JSON
interface: the call site passes a complete JSON value (from the application's own serializer, or
the helper's `json_string` text fallback), the daemon performs canonical redaction, and the helper
stays small — envelope, timestamp, size cap, control-character/framing guard, and secure append
only.
