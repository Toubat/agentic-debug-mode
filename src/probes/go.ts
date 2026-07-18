import type { ProbeTemplates } from "./render";

export function renderGoTemplate(): ProbeTemplates {
  return {
    callTemplate: [
      "// #region agent log",
      '__agentDebugEmit("__HYPOTHESIS_ID__", "__LOCATION__", "__MESSAGE__", __DATA_EXPRESSION__)',
      "// #endregion",
    ].join("\n"),
    helperTemplate: [
      "// #region agent log",
      'import "encoding/json"',
      'import "os"',
      'import "time"',
      "",
      "func __agentDebugEmit(hypothesisID string, location string, message string, data any) {",
      "\tdefer func() { _ = recover() }()",
      "\tpayload, err := json.Marshal(map[string]any{",
      '\t\t"hypothesisId": hypothesisID,',
      '\t\t"location": location,',
      '\t\t"message": message,',
      '\t\t"data": data,',
      '\t\t"timestamp": time.Now().UnixMilli(),',
      "\t})",
      "\tif err != nil || len(payload)+1 > 65_536 { return }",
      "\tpayload = append(payload, '\\n')",
      '\tfile, err := os.OpenFile("__APPEND_PATH__", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)',
      "\tif err != nil { return }",
      "\tdefer func() { _ = file.Close() }()",
      "\t_, _ = file.Write(payload)",
      "}",
      "// #endregion",
    ].join("\n"),
    ingest: "file",
    language: "go",
    placeholders: {
      __APPEND_PATH__: "Replace with the appendPath returned by debug-mode create.",
      __DATA_EXPRESSION__: "Replace with a JSON-compatible Go expression that has no secrets.",
      __HYPOTHESIS_ID__: "Replace with the hypothesis label.",
      __LOCATION__: "Replace with the observed source location.",
      __MESSAGE__: "Replace with a constant observation message.",
    },
  };
}
