import { getOrCreateControlToken } from "./auth";
import { Persistence } from "./persistence";
import { startDaemonServer } from "./server";
import { SessionRegistry } from "./session-registry";

export interface RunDaemonOptions {
  homeDirectory?: string;
  nonce: string;
}

export async function runDaemon(options: RunDaemonOptions): Promise<void> {
  const persistence = await Persistence.open(options.homeDirectory);
  const controlToken = await getOrCreateControlToken(persistence.stateRoot);
  const sessions = new SessionRegistry(persistence);
  const { stopped } = await startDaemonServer({
    controlToken,
    getActiveSessionCount: async () =>
      (await sessions.list()).filter((session) => session.status === "active").length,
    nonce: options.nonce,
    stateRoot: persistence.stateRoot,
  });
  await stopped;
}
