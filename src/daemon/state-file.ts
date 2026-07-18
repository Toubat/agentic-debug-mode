import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../platform/atomic-file";
import type { DaemonMetadata } from "./protocol";

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function daemonStatePath(stateRoot: string): string {
  return join(stateRoot, "daemon.json");
}

export function readyCandidatePath(stateRoot: string, nonce: string): string {
  return join(stateRoot, "ready", `${nonce}.json`);
}

export async function readDaemonState(stateRoot: string): Promise<DaemonMetadata | undefined> {
  try {
    return await readJsonFile<DaemonMetadata>(daemonStatePath(stateRoot));
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

export async function writeDaemonState(stateRoot: string, metadata: DaemonMetadata): Promise<void> {
  await writeJsonAtomic(daemonStatePath(stateRoot), metadata);
}

export async function readReadyCandidate(
  stateRoot: string,
  nonce: string,
): Promise<DaemonMetadata | undefined> {
  try {
    return await readJsonFile<DaemonMetadata>(readyCandidatePath(stateRoot, nonce));
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

export async function publishReadyCandidate(
  stateRoot: string,
  metadata: DaemonMetadata,
): Promise<void> {
  await writeJsonAtomic(readyCandidatePath(stateRoot, metadata.nonce), metadata);
}

export async function removeReadyCandidate(stateRoot: string, nonce: string): Promise<void> {
  await rm(readyCandidatePath(stateRoot, nonce), { force: true });
}

export async function removeOwnedDaemonState(stateRoot: string, nonce: string): Promise<void> {
  try {
    const contents = await readFile(daemonStatePath(stateRoot), "utf8");
    const current = JSON.parse(contents) as DaemonMetadata;
    if (current.nonce === nonce) {
      await rm(daemonStatePath(stateRoot), { force: true });
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}
