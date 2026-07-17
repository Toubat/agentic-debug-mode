export interface ProcessInspection {
  exists: boolean;
  pid: number;
}

export interface TerminationResult {
  reason: string;
  terminated: boolean;
}

interface SystemAddon {
  inspectProcess(pid: number): ProcessInspection;
  terminateIfIdentityMatches(pid: number, identity: string): TerminationResult;
}

const addon = require("../../native/system/addon.node") as SystemAddon;

export function inspectProcess(pid: number): ProcessInspection {
  return addon.inspectProcess(pid);
}

export function terminateIfIdentityMatches(pid: number, identity: string): TerminationResult {
  return addon.terminateIfIdentityMatches(pid, identity);
}
