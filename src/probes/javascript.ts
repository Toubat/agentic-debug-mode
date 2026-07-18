import type { ProbeContext } from "./render";

export interface JavaScriptProbeTemplates {
  callTemplate: string;
  helperTemplate: string;
  language: "javascript";
  replace: string[];
  runtime: "browser-or-node";
  transport: "http";
}

export function renderJavaScriptProbe(input: ProbeContext): JavaScriptProbeTemplates {
  const helperTemplate = [
    "// #region agent log",
    "const __agentDebugEmit = (event) => {",
    "  try {",
    "    const payload = {",
    "      ...event,",
    "      timestamp: Date.now(),",
    "    };",
    `    void fetch(${JSON.stringify(input.ingestUrl)}, {`,
    '      method: "POST",',
    '      headers: { "Content-Type": "application/json" },',
    "      body: JSON.stringify(payload),",
    "    }).catch(() => undefined);",
    "  } catch {",
    "    // Debug probes must never change application behavior.",
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
    language: "javascript",
    replace: ["__HYPOTHESIS_ID__", "__LOCATION__", "__MESSAGE__", "__DATA_EXPRESSION__"],
    runtime: "browser-or-node",
    transport: "http",
  };
}
