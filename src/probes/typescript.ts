import type { ProbeTemplates } from "./render";

export function renderTypeScriptTemplate(): ProbeTemplates {
  const helperTemplate = [
    "// #region agent log",
    "const __agentDebugEmit = (event: {",
    "  hypothesisId: string;",
    "  location: string;",
    "  message: string;",
    "  data: unknown;",
    "}): void => {",
    "  try {",
    "    const payload = JSON.stringify({",
    "      ...event,",
    "      timestamp: Date.now(),",
    '    }) + "\\n";',
    "    if (new TextEncoder().encode(payload).byteLength > 65_536) return;",
    '    void fetch("__INGEST_URL__", {',
    '      method: "POST",',
    '      headers: { "Content-Type": "application/x-ndjson" },',
    "      body: payload,",
    "    }).catch(() => undefined);",
    "  } catch {",
    "    // Observations must never change application behavior.",
    "  }",
    "};",
    "// #endregion",
  ].join("\n");
  const callTemplate = [
    "// #region agent log",
    "__agentDebugEmit({",
    '  hypothesisId: "__HYPOTHESIS_ID__",',
    '  location: "__LOCATION__",',
    '  message: "__MESSAGE__",',
    "  data: __DATA_EXPRESSION__,",
    "});",
    "// #endregion",
  ].join("\n");
  return {
    callTemplate,
    helperTemplate,
    ingest: "http",
    language: "typescript",
    placeholders: {
      __DATA_EXPRESSION__:
        "Replace with a JSON-compatible TypeScript expression that has no secrets.",
      __HYPOTHESIS_ID__: "Replace with the hypothesis label.",
      __INGEST_URL__: "Replace with the ingestUrl returned by debug-mode create.",
      __LOCATION__: "Replace with the observed source location.",
      __MESSAGE__: "Replace with a constant observation message.",
    },
  };
}
