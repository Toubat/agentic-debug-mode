import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { ServerResponse } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonShutdown } from "../../../src/cli/daemon-client";
import type { ControlApi } from "../../../src/daemon/control-api";
import type { IngestApi } from "../../../src/daemon/ingest-api";
import { Persistence } from "../../../src/daemon/persistence";
import { startDaemonServer } from "../../../src/daemon/server";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("SSE backpressure cleanup", () => {
  test("cancels a blocked stream when the slow reader disconnects before drain", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-backpressure-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);
    const token = "backpressure-control-token";
    let markCancelled: (() => void) | undefined;
    const cancelled = new Promise<void>((resolve) => {
      markCancelled = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        markCancelled?.();
      },
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    let responseBody: ReadableStream<Uint8Array> | null | undefined;
    const controlApi = {
      async handle(_request: Request, pathname: string) {
        if (pathname !== "/v1/control/slow") {
          return undefined;
        }
        const response = new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
          status: 200,
        });
        responseBody = response.body;
        return response;
      },
    } as unknown as ControlApi;
    const ingestApi = {
      async handle() {
        return undefined;
      },
    } as unknown as IngestApi;
    let markBlocked: ((response: ServerResponse) => void) | undefined;
    const blocked = new Promise<ServerResponse>((resolve) => {
      markBlocked = resolve;
    });
    const originalWrite = ServerResponse.prototype.write;
    ServerResponse.prototype.write = function forcedBackpressure(this: ServerResponse): boolean {
      markBlocked?.(this);
      markBlocked = undefined;
      return false;
    } as typeof ServerResponse.prototype.write;
    let markFinished: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      markFinished = resolve;
    });

    const { metadata } = await startDaemonServer({
      controlApi,
      controlToken: token,
      getActiveSessionCount: async () => 0,
      hooks: {
        onResponseFinished() {
          markFinished?.();
        },
      },
      ingestApi,
      nonce: randomUUID(),
      stateRoot: persistence.stateRoot,
    });
    const connection = { ...metadata, controlToken: token };
    const socket = connect({ host: metadata.host, port: metadata.port });
    let blockedResponse: ServerResponse | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.pause();
      socket.write(
        [
          "GET /v1/control/slow HTTP/1.1",
          `Host: ${metadata.host}:${metadata.port}`,
          `Authorization: Bearer ${token}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );
      const outgoing = await blocked;
      blockedResponse = outgoing;
      expect(outgoing.statusCode).toBe(200);
      expect(outgoing.getHeader("content-type")).toBe("text/event-stream");
      const closed = new Promise<void>((resolve) => outgoing.once("close", resolve));

      socket.destroy();
      outgoing.emit("close");
      await closed;
      await finished;

      expect(outgoing.listenerCount("drain")).toBe(0);
      expect(outgoing.listenerCount("error")).toBe(0);
      expect(outgoing.listenerCount("close")).toBe(0);
      await cancelled;
      expect(responseBody?.locked).toBe(false);
    } finally {
      blockedResponse?.emit("drain");
      ServerResponse.prototype.write = originalWrite;
      socket.destroy();
      await requestDaemonShutdown(connection);
    }
  });
});
