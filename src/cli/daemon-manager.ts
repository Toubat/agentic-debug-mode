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
import { readDaemonHealth, requestDaemonShutdown } from "./daemon-client";

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

async function retireVerifiedStaleProcess(
  stateRoot: string,
  controlToken: string,
  clock: DaemonManagerClock,
): Promise<void> {
  const state = await readDaemonState(stateRoot);
  if (!state) {
    return;
  }
  const connection = { ...state, controlToken };
  const health = await readDaemonHealth(connection);
  if (health) {
    if (isCompatible(health)) {
      return;
    }
    if ((health.activeSessions ?? 0) > 0) {
      throw new DaemonVersionIncompatibleError(
        "An incompatible daemon has active sessions and cannot be replaced",
      );
    }
    await requestDaemonShutdown(connection);
    return;
  }

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
      await retireVerifiedStaleProcess(persistence.stateRoot, controlToken, clock);
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
