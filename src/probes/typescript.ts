export interface TypeScriptProbeTemplates {
  callTemplate: string;
  helperTemplate: string;
  language: "typescript";
  replace: string[];
  runtime: "browser-or-node";
  transport: "http";
}

export function renderTypeScriptProbe(input: {
  ingestUrl: string;
  runId: string;
  sessionId: string;
}): TypeScriptProbeTemplates {
  const helperTemplate = [
    "// #region agent log",
    "const __agentDebugEmit = (event: {",
    "  hypothesisId: string;",
    "  location: string;",
    "  message: string;",
    "  data: unknown;",
    "}): void => {",
    "  try {",
    "    const payload = {",
    "      ...event,",
    "      schemaVersion: 1,",
    `      sessionId: ${JSON.stringify(input.sessionId)},`,
    `      runId: ${JSON.stringify(input.runId)},`,
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
    language: "typescript",
    replace: ["__HYPOTHESIS_ID__", "__LOCATION__", "__MESSAGE__", "__DATA_EXPRESSION__"],
    runtime: "browser-or-node",
    transport: "http",
  };
}
