export interface ProcessInspection {
  exists: boolean;
  executable?: string;
  pid: number;
  startTime?: number;
  zombie: boolean;
}

export interface TerminationResult {
  reason: string;
  terminated: boolean;
}

interface SystemAddon {
  inspectProcess(pid: number): ProcessInspection;
  terminateIfIdentityMatches(pid: number, identity: string, force?: boolean): TerminationResult;
}

const addon = require("../../native/system/addon.node") as SystemAddon;

export function inspectProcess(pid: number): ProcessInspection {
  return addon.inspectProcess(pid);
}

export function terminateIfIdentityMatches(
  pid: number,
  identity: string,
  force = false,
): TerminationResult {
  return addon.terminateIfIdentityMatches(pid, identity, force);
}
