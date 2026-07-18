import type { DaemonConnection, DaemonMetadata } from "../daemon/protocol";

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
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error("Daemon did not stop before the shutdown deadline");
}
