import type { DaemonConnection, DaemonMetadata } from "../daemon/protocol";

function endpoint(connection: Pick<DaemonConnection, "host" | "port">, path: string): string {
  return `http://${connection.host}:${connection.port}${path}`;
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
