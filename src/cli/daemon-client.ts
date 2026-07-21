import type { DaemonConnection, DaemonMetadata } from "../daemon/protocol";
import { inspectProcess } from "../native/system";

export class DaemonControlError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DaemonControlError";
  }
}

function endpoint(connection: Pick<DaemonConnection, "host" | "port">, path: string): string {
  return `http://${connection.host}:${connection.port}${path}`;
}

export async function requestDaemonControl<T>(
  connection: DaemonConnection,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${connection.controlToken}`);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(endpoint(connection, path), {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    const details = (await response.json().catch(() => undefined)) as
      | { code?: string; message?: string }
      | undefined;
    throw new DaemonControlError(
      details?.code ?? "DAEMON_UNAVAILABLE",
      response.status,
      details?.message ?? `Daemon control request failed with status ${response.status}.`,
    );
  }
  return (await response.json()) as T;
}

export async function readDaemonHealth(
  connection: Pick<DaemonConnection, "controlToken" | "host" | "port">,
): Promise<DaemonMetadata | undefined> {
  try {
    const response = await fetch(endpoint(connection, "/v1/control/health"), {
      headers: { Authorization: `Bearer ${connection.controlToken}` },
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as DaemonMetadata;
  } catch {
    return undefined;
  }
}

export async function requestDaemonShutdown(connection: DaemonConnection): Promise<void> {
  const response = await fetch(endpoint(connection, "/v1/control/shutdown"), {
    headers: { Authorization: `Bearer ${connection.controlToken}` },
    method: "POST",
    signal: AbortSignal.timeout(1_000),
  });
  if (response.status !== 202) {
    throw new Error(`Daemon rejected shutdown with status ${response.status}`);
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await readDaemonHealth(connection))) {
      await waitForRecordedProcessExit(connection, deadline);
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error("Daemon did not stop before the shutdown deadline");
}

// Once the daemon stops answering health checks its listener socket is closed, but
// on Windows the process can briefly outlive that moment while it unwinds and the
// OS releases the mandatory locks it holds on files under the daemon home (spool,
// state, native addon). Callers — the `stop` command and integration tests alike —
// routinely delete that home directory the instant shutdown returns, so on win32
// wait for the recorded process to actually exit first; otherwise the delete races
// a dying process and surfaces as EBUSY/EACCES/EFAULT. The recorded identity guards
// against a reused pid. POSIX has no such mandatory locks, so it returns as soon as
// the daemon stops answering. If the process somehow lingers past the shutdown
// deadline it has still acknowledged and stopped serving, so return rather than
// fail; the callers' filesystem retries cover the residual window.
async function waitForRecordedProcessExit(
  connection: Pick<DaemonConnection, "pid" | "processIdentity">,
  deadline: number,
): Promise<void> {
  // A real daemon is always a separate spawned process; only then can waiting for
  // it to exit release locks the caller is about to act on. An in-process server
  // (integration tests that call startDaemonServer directly) records the current
  // pid, which will never exit here — closing its listener is all the caller can
  // observe, so return once health is already down rather than spin to the deadline.
  if (process.platform !== "win32" || connection.pid === process.pid) {
    return;
  }
  while (Date.now() < deadline) {
    const current = inspectProcess(connection.pid);
    if (
      !current.exists ||
      current.zombie ||
      current.startTime !== connection.processIdentity.startTime ||
      current.executable !== connection.processIdentity.executable
    ) {
      return;
    }
    await Bun.sleep(20);
  }
}
