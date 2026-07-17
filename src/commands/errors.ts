import { DaemonControlError } from "../cli/daemon-client";
import { DaemonVersionIncompatibleError } from "../cli/daemon-manager";
import type { CommandOutput } from "../cli/output-schema";

export function commandError(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): CommandOutput {
  const code =
    error instanceof DaemonVersionIncompatibleError
      ? "VERSION_INCOMPATIBLE"
      : error instanceof DaemonControlError
        ? error.code
        : fallbackCode;
  return {
    error: {
      code,
      message: error instanceof Error ? error.message : fallbackMessage,
    },
    ok: false,
    schemaVersion: 1,
  };
}
