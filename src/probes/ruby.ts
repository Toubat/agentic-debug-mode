import type { ProbeTemplates } from "./render";

export function renderRubyTemplate(): ProbeTemplates {
  return {
    callTemplate: [
      "# region agent log",
      '__agent_debug_emit("__HYPOTHESIS_ID__", "__LOCATION__", "__MESSAGE__", __DATA_EXPRESSION__)',
      "# endregion",
    ].join("\n"),
    helperTemplate: [
      "# region agent log",
      'require "json"',
      "",
      "def __agent_debug_emit(hypothesis_id, location, message, data)",
      "  payload = JSON.generate(",
      "    hypothesisId: hypothesis_id,",
      "    location: location,",
      "    message: message,",
      "    data: data,",
      "    timestamp: (Time.now.to_f * 1000).to_i",
      '  ).encode("UTF-8") + "\\n"',
      "  return if payload.bytesize > 65_536",
      '  File.open("__APPEND_PATH__", "ab", 0o600) { |file| file.write(payload) }',
      "rescue StandardError",
      "  nil",
      "end",
      "# endregion",
    ].join("\n"),
    ingest: "file",
    language: "ruby",
    placeholders: {
      __APPEND_PATH__: "Replace with the appendPath returned by debug-mode create.",
      __DATA_EXPRESSION__: "Replace with a JSON-compatible Ruby expression that has no secrets.",
      __HYPOTHESIS_ID__: "Replace with the hypothesis label.",
      __LOCATION__: "Replace with the observed source location.",
      __MESSAGE__: "Replace with a constant observation message.",
    },
  };
}
