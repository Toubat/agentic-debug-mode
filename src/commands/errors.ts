import { DaemonControlError } from "../cli/daemon-client";
import { DaemonVersionIncompatibleError } from "../cli/daemon-manager";
import type { CommandOutput } from "../cli/output-schema";
import { InvalidSessionIdError } from "../cli/session-path";

export function commandError(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): CommandOutput {
  const code =
    error instanceof DaemonVersionIncompatibleError
      ? "VERSION_INCOMPATIBLE"
      : error instanceof InvalidSessionIdError
        ? error.code
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
