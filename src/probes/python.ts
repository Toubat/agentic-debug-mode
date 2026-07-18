import type { ProbeTemplates } from "./render";

export function renderPythonTemplate(): ProbeTemplates {
  const helperTemplate = [
    "# region agent log",
    "import json",
    "import os",
    "import time",
    "",
    "def __agent_debug_emit(hypothesis_id, location, message, data):",
    "    try:",
    "        payload = json.dumps(",
    "            {",
    '                "hypothesisId": hypothesis_id,',
    '                "location": location,',
    '                "message": message,',
    '                "data": data,',
    '                "timestamp": int(time.time() * 1000),',
    "            },",
    "            allow_nan=False,",
    '            separators=(",", ":"),',
    '        ).encode("utf-8") + b"\\n"',
    "        if len(payload) > 65_536:",
    "            return",
    '        descriptor = os.open("__APPEND_PATH__", os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)',
    "        try:",
    "            os.write(descriptor, payload)",
    "        finally:",
    "            os.close(descriptor)",
    "    except Exception:",
    "        pass",
    "# endregion",
  ].join("\n");
  const callTemplate = [
    "# region agent log",
    "__agent_debug_emit(",
    '    "__HYPOTHESIS_ID__",',
    '    "__LOCATION__",',
    '    "__MESSAGE__",',
    "    __DATA_EXPRESSION__,",
    ")",
    "# endregion",
  ].join("\n");
  return {
    callTemplate,
    helperTemplate,
    ingest: "file",
    language: "python",
    placeholders: {
      __APPEND_PATH__: "Replace with the appendPath returned by debug-mode create.",
      __DATA_EXPRESSION__: "Replace with a JSON-compatible Python expression that has no secrets.",
      __HYPOTHESIS_ID__: "Replace with the hypothesis label.",
      __LOCATION__: "Replace with the observed source location.",
      __MESSAGE__: "Replace with a constant observation message.",
    },
  };
}
