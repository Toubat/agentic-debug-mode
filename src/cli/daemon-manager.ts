import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import packageJson from "../../package.json";
import { getOrCreateControlToken } from "../daemon/auth";
import { Persistence } from "../daemon/persistence";
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonConnection,
  type DaemonMetadata,
} from "../daemon/protocol";
import { StartupLock } from "../daemon/startup-lock";
import {
  readDaemonState,
  readReadyCandidate,
  removeReadyCandidate,
  writeDaemonState,
} from "../daemon/state-file";
import { inspectProcess, terminateIfIdentityMatches } from "../native/system";
import { DaemonControlError, readDaemonHealth, requestDaemonShutdown } from "./daemon-client";

export interface DaemonManagerClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface SpawnedDaemon {
  hasExited(): boolean;
  retire(): Promise<void>;
}

export interface EnsureDaemonOptions {
  homeDirectory?: string;
  testHooks?: {
    clock?: DaemonManagerClock;
    command?: string[];
    launchDaemon?(nonce: string, homeDirectory?: string): Promise<SpawnedDaemon>;
    startupTimeoutMilliseconds?: number;
  };
}

export type EnsureDaemonFunction = (options?: EnsureDaemonOptions) => Promise<DaemonConnection>;

export class DaemonVersionIncompatibleError extends Error {}

const systemManagerClock: DaemonManagerClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => Bun.sleep(milliseconds),
};

function isCompatible(metadata: DaemonMetadata): boolean {
  return (
    metadata.protocolVersion === DAEMON_PROTOCOL_VERSION &&
    metadata.binaryVersion === packageJson.version
  );
}

async function readReusableConnection(
  stateRoot: string,
  controlToken: string,
): Promise<DaemonConnection | undefined> {
  const state = await readDaemonState(stateRoot);
  if (!state) {
    return undefined;
  }
  const connection = { ...state, controlToken };
  const health = await readDaemonHealth(connection);
  if (
    !health ||
    health.nonce !== state.nonce ||
    health.pid !== state.pid ||
    !isCompatible(health)
  ) {
    return undefined;
  }
  if (!isCompatible(state)) {
    await writeDaemonState(stateRoot, health);
  }
  return { ...health, controlToken };
}

function daemonCommand(): string[] {
  const sourceCli = join(import.meta.dir, "..", "cli.ts");
  if (basename(process.execPath).startsWith("bun") && existsSync(sourceCli)) {
    return [process.execPath, sourceCli, "__daemon"];
  }
  return [process.execPath, "__daemon"];
}

class DaemonChildExitedError extends Error {}

function spawnDaemon(
  nonce: string,
  homeDirectory?: string,
  command = daemonCommand(),
  clock: DaemonManagerClock = systemManagerClock,
): SpawnedDaemon {
  const child = Bun.spawn([...command, "--nonce", nonce], {
    env: {
      ...process.env,
      AGENT_DEBUG_MODE_HOME_OVERRIDE: homeDirectory,
    },
    // On Windows, detach into its own process group so the daemon's lifetime is
    // decoupled from the spawning CLI process (which exits immediately). POSIX
    // already survives parent exit via unref(); keep its behavior unchanged.
    detached: process.platform === "win32",
    stderr: "ignore",
    stdin: "ignore",
    stdout: "ignore",
    windowsHide: true,
  });
  const initial = inspectProcess(child.pid);
  const identity =
    initial.exists && !initial.zombie && initial.executable && initial.startTime !== undefined
      ? { executable: initial.executable, startTime: initial.startTime }
      : undefined;
  child.unref();
  return {
    hasExited: () => {
      const process = inspectProcess(child.pid);
      return !process.exists || process.zombie;
    },
    retire: async () => {
      if (!identity) {
        return;
      }
      terminateIfIdentityMatches(child.pid, JSON.stringify(identity));
      const gracefulDeadline = clock.now() + 1_000;
      while (clock.now() < gracefulDeadline) {
        const current = inspectProcess(child.pid);
        if (!current.exists || current.zombie) {
          return;
        }
        await clock.sleep(20);
      }
      terminateIfIdentityMatches(child.pid, JSON.stringify(identity), true);
    },
  };
}

async function awaitReadyCandidate(
  stateRoot: string,
  nonce: string,
  controlToken: string,
  spawned: SpawnedDaemon,
  timeoutMilliseconds = 10_000,
  clock: DaemonManagerClock = systemManagerClock,
): Promise<DaemonConnection> {
  const deadline = clock.now() + timeoutMilliseconds;
  let candidateSeen = false;
  let healthSeen = false;
  while (clock.now() < deadline) {
    const candidate = await readReadyCandidate(stateRoot, nonce);
    if (candidate) {
      candidateSeen = true;
      const connection = { ...candidate, controlToken };
      const health = await readDaemonHealth(connection);
      healthSeen ||= health !== undefined;
      if (health?.nonce === nonce && health.pid === candidate.pid && isCompatible(health)) {
        await writeDaemonState(stateRoot, health);
        await removeReadyCandidate(stateRoot, nonce);
        return { ...health, controlToken };
      }
    }
    if (spawned.hasExited()) {
      throw new DaemonChildExitedError("Daemon child exited before publishing a ready candidate");
    }
    await clock.sleep(20);
  }
  throw new Error(
    `Daemon failed to become ready before the startup deadline (candidateSeen=${candidateSeen}, healthSeen=${healthSeen})`,
  );
}

async function tryAdoptReadyCandidate(
  stateRoot: string,
  nonce: string,
  controlToken: string,
): Promise<DaemonConnection | undefined> {
  const candidate = await readReadyCandidate(stateRoot, nonce);
  if (!candidate || !isCompatible(candidate)) {
    return undefined;
  }
  const connection = { ...candidate, controlToken };
  const health = await readDaemonHealth(connection);
  if (!health || health.nonce !== nonce || health.pid !== candidate.pid || !isCompatible(health)) {
    return undefined;
  }
  await writeDaemonState(stateRoot, health);
  await removeReadyCandidate(stateRoot, nonce);
  return { ...health, controlToken };
}

// Confirm a recorded daemon is genuinely unreachable before treating it as
// stale. A single health probe (500ms) can time out against a daemon that is
// merely busy — e.g. serving a burst of concurrent create callers — and acting
// on that false negative would terminate a live daemon out from under the
// callers currently connected to it. Retry a few times so only a daemon that
// stays silent is declared dead.
export async function probeDaemonHealth(
  connection: Pick<DaemonConnection, "controlToken" | "host" | "port">,
  clock: DaemonManagerClock = systemManagerClock,
  attempts = 5,
): Promise<DaemonMetadata | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const health = await readDaemonHealth(connection);
    if (health) {
      return health;
    }
    if (attempt < attempts - 1) {
      await clock.sleep(100);
    }
  }
  return undefined;
}

async function retireVerifiedStaleProcess(
  stateRoot: string,
  controlToken: string,
  clock: DaemonManagerClock,
): Promise<DaemonConnection | undefined> {
  const state = await readDaemonState(stateRoot);
  if (!state) {
    return undefined;
  }
  const connection = { ...state, controlToken };
  const health = await probeDaemonHealth(connection, clock);
  if (health) {
    if (isCompatible(health)) {
      // The daemon is alive and compatible after all; never retire it. If it
      // still matches the recorded identity, reuse it rather than spawning a
      // redundant replacement.
      if (health.nonce === state.nonce && health.pid === state.pid) {
        return { ...health, controlToken };
      }
      return undefined;
    }
    if ((health.activeSessions ?? 0) > 0) {
      throw new DaemonVersionIncompatibleError(
        "An incompatible daemon has active sessions and cannot be replaced",
      );
    }
    await requestDaemonShutdown(connection);
    return undefined;
  }

  await ensureRecordedProcessGone(state, clock);
}

// Resolves once the RECORDED daemon process is verifiably absent: already dead,
// identity-mismatched (an unrelated process reused the pid), or terminated here
// with graceful-then-forced escalation. Throws only when even a forced signal
// leaves the identity-verified process running.
export async function ensureRecordedProcessGone(
  state: DaemonMetadata,
  clock: DaemonManagerClock = systemManagerClock,
): Promise<void> {
  const process = inspectProcess(state.pid);
  if (
    !process.exists ||
    process.zombie ||
    process.startTime !== state.processIdentity.startTime ||
    process.executable !== state.processIdentity.executable
  ) {
    return;
  }
  const result = terminateIfIdentityMatches(state.pid, JSON.stringify(state.processIdentity));
  if (!result.terminated) {
    return;
  }

  const deadline = clock.now() + 2_000;
  while (clock.now() < deadline) {
    const current = inspectProcess(state.pid);
    if (!current.exists || current.zombie) {
      return;
    }
    await clock.sleep(20);
  }

  const forced = terminateIfIdentityMatches(state.pid, JSON.stringify(state.processIdentity), true);
  if (!forced.terminated) {
    return;
  }
  const forcedDeadline = clock.now() + 2_000;
  while (clock.now() < forcedDeadline) {
    const current = inspectProcess(state.pid);
    if (!current.exists || current.zombie) {
      return;
    }
    await clock.sleep(20);
  }
  throw new Error("Verified stale daemon did not terminate after a forced signal");
}

const inFlightStarts = new Map<string, Promise<DaemonConnection>>();

async function ensureDaemonOnce(
  persistence: Persistence,
  options: EnsureDaemonOptions,
): Promise<DaemonConnection> {
  const clock = options.testHooks?.clock ?? systemManagerClock;
  const controlToken = await getOrCreateControlToken(persistence.stateRoot);
  const deadline = clock.now() + 15_000;

  while (clock.now() < deadline) {
    const reusable = await readReusableConnection(persistence.stateRoot, controlToken);
    if (reusable) {
      return reusable;
    }

    const nonce = randomUUID();
    const lock = await StartupLock.tryAcquire(persistence.stateRoot, {
      deadline,
      nonce,
      pid: process.pid,
    });
    if (!lock) {
      const owner = await StartupLock.readOwner(persistence.stateRoot);
      if (owner) {
        const ownerProcess = inspectProcess(owner.pid);
        if (!ownerProcess.exists || ownerProcess.zombie) {
          const adopted = await tryAdoptReadyCandidate(
            persistence.stateRoot,
            owner.nonce,
            controlToken,
          );
          if (adopted) {
            await StartupLock.breakIfOwnedBy(persistence.stateRoot, owner);
            return adopted;
          }
          if (owner.deadline < clock.now()) {
            await StartupLock.breakIfOwnedBy(persistence.stateRoot, owner);
          }
        }
      } else if (!owner) {
        await StartupLock.breakIfUnownedAndOlderThan(persistence.stateRoot, 250);
      }
      await clock.sleep(20);
      continue;
    }

    try {
      const rechecked = await readReusableConnection(persistence.stateRoot, controlToken);
      if (rechecked) {
        return rechecked;
      }
      const revived = await retireVerifiedStaleProcess(persistence.stateRoot, controlToken, clock);
      if (revived) {
        return revived;
      }
      let lastStartupError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let spawned: SpawnedDaemon;
        try {
          spawned = options.testHooks?.launchDaemon
            ? await options.testHooks.launchDaemon(nonce, options.homeDirectory)
            : spawnDaemon(nonce, options.homeDirectory, options.testHooks?.command, clock);
        } catch (error) {
          lastStartupError = error;
          await clock.sleep(25 * (attempt + 1));
          continue;
        }
        try {
          return await awaitReadyCandidate(
            persistence.stateRoot,
            nonce,
            controlToken,
            spawned,
            options.testHooks?.startupTimeoutMilliseconds,
            clock,
          );
        } catch (error) {
          await spawned.retire();
          if (!(error instanceof DaemonChildExitedError)) {
            throw error;
          }
          lastStartupError = error;
          await clock.sleep(25 * (attempt + 1));
        }
      }
      throw lastStartupError;
    } finally {
      await lock.release();
    }
  }

  throw new Error("Unable to acquire the daemon startup lock before the deadline");
}

/**
 * Classify a daemon interaction failure as a transient connection problem
 * (worth retrying) rather than a typed command failure. On Windows a freshly
 * spawned daemon or one whose listener briefly drops a connection surfaces as a
 * closed socket / refused connection, or as an untyped DAEMON_UNAVAILABLE from a
 * request that raced a file replacement. Typed command failures (any other
 * DaemonControlError code) are never treated as transient.
 */
export function isTransientDaemonError(error: unknown): boolean {
  if (error instanceof DaemonControlError) {
    return error.code === "DAEMON_UNAVAILABLE";
  }
  if (error instanceof Error) {
    return /socket connection|connection (was )?closed|connection reset|ECONNREFUSED|ECONNRESET|EPIPE|Unable to connect|failed to connect|fetch failed/i.test(
      `${error.message} ${(error as { code?: string }).code ?? ""}`,
    );
  }
  return false;
}

/**
 * Run a daemon interaction with a bounded retry on transient connection errors.
 * Each attempt re-runs the provided action, which is expected to re-discover or
 * re-establish the daemon connection. Typed command failures propagate immediately.
 */
export async function withTransientDaemonRetry<T>(
  action: () => Promise<T>,
  attempts = 3,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) => Bun.sleep(milliseconds),
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (!isTransientDaemonError(error) || attempt === attempts - 1) {
        throw error;
      }
      lastError = error;
      await sleep(25 * (attempt + 1));
    }
  }
  throw lastError;
}

export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<DaemonConnection> {
  const persistence = await Persistence.open(options.homeDirectory);
  const current = inFlightStarts.get(persistence.stateRoot);
  if (current) {
    return current;
  }

  const startup = ensureDaemonOnce(persistence, options);
  inFlightStarts.set(persistence.stateRoot, startup);
  try {
    return await startup;
  } finally {
    if (inFlightStarts.get(persistence.stateRoot) === startup) {
      inFlightStarts.delete(persistence.stateRoot);
    }
  }
}
