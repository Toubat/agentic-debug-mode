import type { ProbeTemplates } from "./render";

export function renderPhpTemplate(): ProbeTemplates {
  return {
    callTemplate: [
      "// #region agent log",
      '__agentDebugEmit("__HYPOTHESIS_ID__", "__LOCATION__", "__MESSAGE__", __DATA_EXPRESSION__);',
      "// #endregion",
    ].join("\n"),
    helperTemplate: [
      "// #region agent log",
      "function __agentDebugEmit(string $hypothesisId, string $location, string $message, mixed $data): void",
      "{",
      "    try {",
      "        $payload = json_encode([",
      '            "hypothesisId" => $hypothesisId,',
      '            "location" => $location,',
      '            "message" => $message,',
      '            "data" => $data,',
      '            "timestamp" => (int) floor(microtime(true) * 1000),',
      '        ], JSON_THROW_ON_ERROR) . "\\n";',
      "        if (strlen($payload) > 65_536) {",
      "            return;",
      "        }",
      '        @file_put_contents("__APPEND_PATH__", $payload, FILE_APPEND | LOCK_EX);',
      "    } catch (Throwable) {",
      "        // Observations must never change application behavior.",
      "    }",
      "}",
      "// #endregion",
    ].join("\n"),
    ingest: "file",
    language: "php",
    placeholders: {
      __APPEND_PATH__: "Replace with the appendPath returned by debug-mode create.",
      __DATA_EXPRESSION__: "Replace with a JSON-compatible PHP expression that has no secrets.",
      __HYPOTHESIS_ID__: "Replace with the hypothesis label.",
      __LOCATION__: "Replace with the observed source location.",
      __MESSAGE__: "Replace with a constant observation message.",
    },
  };
}
