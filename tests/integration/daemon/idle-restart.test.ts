import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDaemonHealth, requestDaemonShutdown } from "../../../src/cli/daemon-client";
import { ensureDaemon } from "../../../src/cli/daemon-manager";
import { dispatch } from "../../../src/cli/dispatch";
import type { CommandResult } from "../../../src/cli/output-schema";
import { parseCli } from "../../../src/cli/program";
import { createCommand, type SessionIngest } from "../../../src/commands/create";
import { logsCommand } from "../../../src/commands/logs";
import { statusCommand } from "../../../src/commands/status";
import { type Clock, IDLE_TIMEOUT_MILLISECONDS } from "../../../src/daemon/activity";
import { getOrCreateControlToken } from "../../../src/daemon/auth";
import { runDaemon } from "../../../src/daemon/main";
import { Persistence } from "../../../src/daemon/persistence";
import type { DaemonConnection, DaemonMetadata } from "../../../src/daemon/protocol";

interface ScheduledCallback {
  callback: () => void;
  cleared: boolean;
  dueAt: number;
}

class FakeClock implements Clock {
  private currentTime = 0;
  readonly scheduled: ScheduledCallback[] = [];

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> {
    const scheduled = {
      callback,
      cleared: false,
      dueAt: this.currentTime + milliseconds,
    };
    this.scheduled.push(scheduled);
    return scheduled as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    (handle as unknown as ScheduledCallback).cleared = true;
  }

  advance(milliseconds: number): void {
    this.currentTime += milliseconds;
    while (true) {
      const next = this.scheduled.find(
        (scheduled) => !scheduled.cleared && scheduled.dueAt <= this.currentTime,
      );
      if (!next) {
        return;
      }
      next.cleared = true;
      next.callback();
    }
  }
}

interface InProcessService {
  connection(): Promise<DaemonConnection>;
  exited: Promise<void>;
  metadata: DaemonMetadata;
}

class InProcessLauncher {
  readonly services: InProcessService[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly homeDirectory: string,
  ) {}

  readonly launchDaemon = async (nonce: string, homeDirectory?: string) => {
    const pid = 80_000 + this.services.length;
    let exited = false;
    let markStarted: ((metadata: DaemonMetadata) => void) | undefined;
    const started = new Promise<DaemonMetadata>((resolve) => {
      markStarted = resolve;
    });
    const running = runDaemon({
      clock: this.clock,
      homeDirectory: homeDirectory ?? this.homeDirectory,
      nonce,
      onStarted(metadata) {
        markStarted?.(metadata);
      },
      processMetadata: {
        pid,
        processIdentity: {
          executable: `/test/service-${pid}`,
          startTime: pid,
        },
      },
    }).finally(() => {
      exited = true;
    });
    const metadata = await started;
    const service: InProcessService = {
      async connection() {
        const persistence = await Persistence.open(homeDirectory);
        return {
          ...metadata,
          controlToken: await getOrCreateControlToken(persistence.stateRoot),
        };
      },
      exited: running,
      metadata,
    };
    this.services.push(service);
    return {
      hasExited: () => exited,
      retire: async () => {
        await requestDaemonShutdown(await service.connection()).catch(() => undefined);
        await running;
      },
    };
  };

  async stopAll(): Promise<void> {
    await Promise.all(
      this.services.map(async (service) => {
        await requestDaemonShutdown(await service.connection()).catch(() => undefined);
        await service.exited;
      }),
    );
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("idle service restart", () => {
  test("static commands stay stopped while data commands restart one verified service", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-idle-restart-"));
    temporaryDirectories.push(home);
    const clock = new FakeClock();
    const launcher = new InProcessLauncher(clock, home);
    const ensure = (options: Parameters<typeof ensureDaemon>[0] = {}) =>
      ensureDaemon({
        ...options,
        homeDirectory: home,
        testHooks: {
          clock: {
            now: () => clock.now(),
            sleep: async () => undefined,
          },
          launchDaemon: launcher.launchDaemon,
        },
      });
    try {
      const created = (await createCommand(ensure)) as CommandResult<SessionIngest>;
      expect(created.ok).toBe(true);
      expect(launcher.services).toHaveLength(1);
      const sessionId = created.data?.sessionId;
      expect(sessionId).toBeDefined();
      const first = launcher.services[0];
      expect(first).toBeDefined();
      if (!first || !sessionId) {
        throw new Error("First in-process service or session was not created");
      }
      const firstConnection = await first.connection();
      const ingested = await fetch(
        `http://${firstConnection.host}:${firstConnection.port}/ingest/${sessionId}`,
        {
          body: JSON.stringify({
            data: { retained: true },
            hypothesisId: "H1",
            location: "src/restart.ts:1",
            message: "Persist across idle restart",
            timestamp: 1,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
      expect(ingested.status).toBe(202);

      clock.advance(IDLE_TIMEOUT_MILLISECONDS);
      await first.exited;
      expect(await readDaemonHealth(firstConnection)).toBeUndefined();

      await parseCli(["--help"]);
      await parseCli(["--version"]);
      const template = await parseCli(["template", "--language", "javascript", "--ingest", "http"]);
      if ("helpText" in template) {
        throw new Error("Template invocation unexpectedly returned help");
      }
      await dispatch(template);
      expect(launcher.services).toHaveLength(1);

      const status = await statusCommand(sessionId, ensure);
      expect(status.ok).toBe(true);
      expect(launcher.services).toHaveLength(2);
      const second = launcher.services[1];
      expect(second).toBeDefined();
      expect(second?.metadata.pid).not.toBe(first.metadata.pid);
      expect(second?.metadata.nonce).not.toBe(first.metadata.nonce);
      expect(second?.metadata.processIdentity).not.toEqual(first.metadata.processIdentity);

      const logs = await logsCommand(
        {
          hypotheses: [],
          kind: "logs",
          limit: 100,
          offset: 0,
          sessionId,
        },
        false,
        ensure,
      );
      expect(logs.ok).toBe(true);
      expect(JSON.stringify(logs)).toContain("Persist across idle restart");

      const another = await createCommand(ensure);
      expect(another.ok).toBe(true);
      expect(launcher.services).toHaveLength(2);
    } finally {
      await launcher.stopAll();
    }
  });
});
