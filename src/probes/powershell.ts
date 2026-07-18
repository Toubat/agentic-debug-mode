import type { ProbeTemplates } from "./render";

export function renderPowerShellTemplate(): ProbeTemplates {
  return {
    callTemplate: [
      "# region agent log",
      'Write-AgentDebugEvent "__HYPOTHESIS_ID__" "__LOCATION__" "__MESSAGE__" (__DATA_EXPRESSION__)',
      "# endregion",
    ].join("\n"),
    helperTemplate: [
      "# region agent log",
      "function Write-AgentDebugEvent {",
      "    param(",
      "        [string] $HypothesisId,",
      "        [string] $Location,",
      "        [string] $Message,",
      "        [object] $Data",
      "    )",
      "    try {",
      "        $eventData = [ordered]@{",
      "            hypothesisId = $HypothesisId",
      "            location = $Location",
      "            message = $Message",
      "            data = $Data",
      "            timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
      "        }",
      '        $json = ($eventData | ConvertTo-Json -Compress -Depth 8 -ErrorAction Stop -WarningAction SilentlyContinue) + "`n"',
      "        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)",
      "        if ($bytes.Length -gt 65_536) { return }",
      '        $stream = [IO.File]::Open("__APPEND_PATH__", [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)',
      "        try {",
      "            $stream.Write($bytes, 0, $bytes.Length)",
      "        } finally {",
      "            $stream.Dispose()",
      "        }",
      "    } catch {",
      "        # Observations must never change application behavior.",
      "    }",
      "}",
      "# endregion",
    ].join("\n"),
    ingest: "file",
    language: "powershell",
    placeholders: {
      __APPEND_PATH__: "Replace with the appendPath returned by debug-mode create.",
      __DATA_EXPRESSION__:
        "Replace with a JSON-compatible PowerShell expression that has no secrets.",
      __HYPOTHESIS_ID__: "Replace with the hypothesis label.",
      __LOCATION__: "Replace with the observed source location.",
      __MESSAGE__: "Replace with a constant observation message.",
    },
  };
}
