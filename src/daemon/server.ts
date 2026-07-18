import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import packageJson from "../../package.json";
import { inspectProcess } from "../native/system";
import { ActivityTracker, type Clock, systemClock } from "./activity";
import { isAuthorized } from "./auth";
import type { ControlApi } from "./control-api";
import type { IngestApi } from "./ingest-api";
import {
  DAEMON_HOST,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_SCHEMA_VERSION,
  type DaemonMetadata,
} from "./protocol";
import { parseRawIngestionTarget } from "./raw-request-target";
import { createShutdownController } from "./shutdown";
import { publishReadyCandidate, removeOwnedDaemonState, removeReadyCandidate } from "./state-file";

const MAX_REQUEST_BODY_BYTES = 128 * 1024;

class RequestBodyTooLargeError extends Error {}

export interface DaemonServerHooks {
  onResponseFinished?(): void;
}

function incomingHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name && value) {
      headers.append(name, value);
    }
  }
  return headers;
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const declaredLength = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    throw new RequestBodyTooLargeError();
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > MAX_REQUEST_BODY_BYTES) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json",
  });
  response.end(body);
}

function waitForDrainOrDisconnect(outgoing: ServerResponse, signal: AbortSignal): Promise<boolean> {
  if (outgoing.destroyed || signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const cleanup = () => {
      outgoing.off("drain", onDrain);
      outgoing.off("close", onDisconnect);
      outgoing.off("error", onDisconnect);
      signal.removeEventListener("abort", onDisconnect);
    };
    const settle = (drained: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(drained);
    };
    const onDrain = () => settle(true);
    const onDisconnect = () => settle(false);
    outgoing.once("drain", onDrain);
    outgoing.once("close", onDisconnect);
    outgoing.once("error", onDisconnect);
    signal.addEventListener("abort", onDisconnect, { once: true });
    if (outgoing.destroyed || signal.aborted) {
      settle(false);
    }
  });
}

async function writeWebResponse(
  outgoing: ServerResponse,
  response: Response,
  signal: AbortSignal,
  hooks: DaemonServerHooks,
  activity: ActivityTracker,
): Promise<void> {
  const releaseLease = response.headers.get("content-type")?.startsWith("text/event-stream")
    ? activity.acquireLease()
    : undefined;
  try {
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => {
      outgoing.setHeader(name, value);
    });
    if (!response.body) {
      outgoing.end();
      return;
    }
    const reader = response.body.getReader();
    try {
      while (!outgoing.destroyed) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        if (!outgoing.write(Buffer.from(chunk.value))) {
          if (!(await waitForDrainOrDisconnect(outgoing, signal))) {
            break;
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      hooks.onResponseFinished?.();
    }
    if (!outgoing.destroyed) {
      outgoing.end();
    }
  } finally {
    releaseLease?.();
  }
}

export interface StartDaemonServerOptions {
  clock?: Clock;
  controlToken: string;
  controlApi: ControlApi;
  getActiveSessionCount(): Promise<number>;
  ingestApi: IngestApi;
  hooks?: DaemonServerHooks;
  nonce: string;
  stateRoot: string;
}

export async function startDaemonServer(
  options: StartDaemonServerOptions,
): Promise<{ activity: ActivityTracker; metadata: DaemonMetadata; stopped: Promise<void> }> {
  const shutdown = createShutdownController();
  let metadata: DaemonMetadata;
  let stopping = false;
  let server: ReturnType<typeof createServer>;
  const clock = options.clock ?? systemClock;
  let activity: ActivityTracker;

  const stop = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    activity.stop();
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    server.closeAllConnections();
    await closed;
    await removeOwnedDaemonState(options.stateRoot, options.nonce);
    await removeReadyCandidate(options.stateRoot, options.nonce);
    shutdown.begin();
  };

  activity = new ActivityTracker(clock, () => {
    void stop();
  });

  server = createServer((incoming, outgoing) => {
    activity.touch();
    void (async () => {
      const rawTarget = incoming.url ?? "";
      const ingestionTarget = parseRawIngestionTarget(rawTarget);
      if (ingestionTarget.kind === "invalid-ingestion") {
        writeJson(outgoing, 400, { code: "INVALID_ARGUMENTS" });
        return;
      }
      const host = incoming.headers.host ?? DAEMON_HOST;
      const absoluteTarget = /^https?:\/\//i.test(rawTarget)
        ? rawTarget
        : `http://${host}${rawTarget.startsWith("/") ? rawTarget : "/"}`;
      let url: URL;
      try {
        url = new URL(absoluteTarget);
      } catch {
        writeJson(outgoing, 400, { code: "INVALID_ARGUMENTS" });
        return;
      }
      const abort = new AbortController();
      incoming.once("aborted", () => abort.abort());
      outgoing.once("close", () => abort.abort());
      let body: Buffer;
      try {
        body = await requestBody(incoming);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          writeJson(outgoing, 413, { error: "payload-too-large" });
          return;
        }
        throw error;
      }
      const method = incoming.method ?? "GET";
      const request = new Request(url, {
        body:
          method === "GET" || method === "HEAD" || body.byteLength === 0
            ? undefined
            : new Uint8Array(body),
        headers: incomingHeaders(incoming),
        method,
        signal: abort.signal,
      });
      const pathname =
        ingestionTarget.kind === "ingestion" ? ingestionTarget.pathname : url.pathname;
      const ingestResponse = await options.ingestApi.handle(request, pathname);
      if (ingestResponse) {
        await writeWebResponse(
          outgoing,
          ingestResponse,
          abort.signal,
          options.hooks ?? {},
          activity,
        );
        return;
      }
      if (!isAuthorized(request, options.controlToken)) {
        writeJson(outgoing, 401, { error: "unauthorized" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/control/health") {
        await writeWebResponse(
          outgoing,
          Response.json({
            ...metadata,
            activeSessions: await options.getActiveSessionCount(),
          }),
          abort.signal,
          options.hooks ?? {},
          activity,
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/control/shutdown") {
        setTimeout(() => {
          void stop();
        }, 10);
        await writeWebResponse(
          outgoing,
          Response.json({ accepted: true }, { status: 202 }),
          abort.signal,
          options.hooks ?? {},
          activity,
        );
        return;
      }
      const controlResponse = await options.controlApi.handle(
        request,
        url.pathname,
        `http://${metadata.host}:${metadata.port}`,
      );
      if (controlResponse) {
        await writeWebResponse(
          outgoing,
          controlResponse,
          abort.signal,
          options.hooks ?? {},
          activity,
        );
        return;
      }
      writeJson(outgoing, 404, { error: "not-found" });
    })().catch((error: unknown) => {
      if (!outgoing.headersSent) {
        writeJson(outgoing, 500, { error: "internal-server-error" });
      } else {
        outgoing.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, DAEMON_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const [processInspection, activeSessions] = await Promise.all([
    Promise.resolve(inspectProcess(process.pid)),
    options.getActiveSessionCount(),
  ]);
  const address = server.address();
  if (!address || typeof address === "string") {
    server.closeAllConnections();
    server.close();
    throw new Error("Daemon server did not report its assigned port");
  }
  const port = address.port;
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
    startedAt: clock.now(),
  };
  await publishReadyCandidate(options.stateRoot, metadata);

  const signalStop = () => {
    void stop();
  };
  process.once("SIGINT", signalStop);
  process.once("SIGTERM", signalStop);

  return { activity, metadata, stopped: shutdown.promise };
}
