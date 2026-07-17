import packageJson from "../../package.json";
import { inspectProcess } from "../native/system";
import { isAuthorized } from "./auth";
import {
  DAEMON_HOST,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_SCHEMA_VERSION,
  type DaemonMetadata,
} from "./protocol";
import { createShutdownController } from "./shutdown";
import { publishReadyCandidate, removeOwnedDaemonState, removeReadyCandidate } from "./state-file";

export interface StartDaemonServerOptions {
  controlToken: string;
  getActiveSessionCount(): Promise<number>;
  nonce: string;
  stateRoot: string;
}

export async function startDaemonServer(
  options: StartDaemonServerOptions,
): Promise<{ metadata: DaemonMetadata; stopped: Promise<void> }> {
  const shutdown = createShutdownController();
  let metadata: DaemonMetadata;
  let stopping = false;
  let server: ReturnType<typeof Bun.serve>;

  const stop = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    await server.stop(true);
    await removeOwnedDaemonState(options.stateRoot, options.nonce);
    await removeReadyCandidate(options.stateRoot, options.nonce);
    shutdown.begin();
  };

  server = Bun.serve({
    hostname: DAEMON_HOST,
    port: 0,
    async fetch(request) {
      if (!isAuthorized(request, options.controlToken)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/control/health") {
        return Response.json({
          ...metadata,
          activeSessions: await options.getActiveSessionCount(),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/control/shutdown") {
        setTimeout(() => {
          void stop();
        }, 10);
        return Response.json({ accepted: true }, { status: 202 });
      }
      return Response.json({ error: "not-found" }, { status: 404 });
    },
  });

  const [processInspection, activeSessions] = await Promise.all([
    Promise.resolve(inspectProcess(process.pid)),
    options.getActiveSessionCount(),
  ]);
  const port = server.port;
  if (port === undefined) {
    await server.stop(true);
    throw new Error("Daemon server did not report its assigned port");
  }
  metadata = {
    activeSessions,
    binaryVersion: packageJson.version,
    host: DAEMON_HOST,
    nonce: options.nonce,
    pid: process.pid,
    port,
    processIdentity: {
      executable: processInspection.executable,
      startTime: processInspection.startTime,
    },
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    schemaVersion: DAEMON_SCHEMA_VERSION,
    startedAt: Date.now(),
  };
  await publishReadyCandidate(options.stateRoot, metadata);

  const signalStop = () => {
    void stop();
  };
  process.once("SIGINT", signalStop);
  process.once("SIGTERM", signalStop);

  return { metadata, stopped: shutdown.promise };
}
