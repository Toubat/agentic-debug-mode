import type { ProbeContext } from "./render";

export interface PythonProbeTemplates {
  callTemplate: string;
  helperTemplate: string;
  language: "python";
  replace: string[];
  runtime: "local";
  transport: "direct-append";
}

export function renderPythonProbe(input: ProbeContext): PythonProbeTemplates {
  const helperTemplate = [
    "# region agent log",
    "import atexit",
    "import json",
    "import os",
    "import time",
    "",
    `__agent_debug_fd = os.open(${JSON.stringify(input.ingestPath)}, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)`,
    "atexit.register(os.close, __agent_debug_fd)",
    "",
    "def __agent_debug_emit(hypothesis_id, location, message, data):",
    "    try:",
    "        if not isinstance(data, dict) or any(not isinstance(key, str) for key in data):",
    "            return",
    "        if any(",
    "            value is not None and not isinstance(value, (str, int, float, bool))",
    "            for value in data.values()",
    "        ):",
    "            return",
    "        payload = json.dumps(",
    "            {",
    '                "schemaVersion": 1,',
    `                "sessionId": ${JSON.stringify(input.sessionId)},`,
    `                "runId": ${JSON.stringify(input.runId)},`,
    '                "hypothesisId": hypothesis_id,',
    '                "location": location,',
    '                "message": message,',
    '                "data": data,',
    '                "timestamp": int(time.time() * 1000),',
    "            },",
    "            allow_nan=False,",
    '            separators=(",", ":"),',
    '        ).encode("utf-8") + b"\\n"',
    "        if len(payload) <= 16_384:",
    "            os.write(__agent_debug_fd, payload)",
    "    except (OSError, TypeError, ValueError):",
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
    language: "python",
    replace: ["__HYPOTHESIS_ID__", "__LOCATION__", "__MESSAGE__", "__DATA_EXPRESSION__"],
    runtime: "local",
    transport: "direct-append",
  };
}
