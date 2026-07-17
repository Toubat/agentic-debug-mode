import { getOrCreateControlToken } from "./auth";
import { ControlApi } from "./control-api";
import { DiagnosticStore } from "./diagnostic-store";
import { DirectAppendObserver } from "./direct-append-observer";
import { EventStore } from "./event-store";
import { IngestApi, IngestionService } from "./ingest-api";
import { Persistence } from "./persistence";
import { RunRegistry } from "./run-registry";
import { EventSequence } from "./sequence";
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
  const runs = new RunRegistry(persistence);
  const events = new EventStore(persistence);
  const diagnostics = new DiagnosticStore(persistence);
  const sequence = new EventSequence(events);
  const ingestion = new IngestionService(sessions, runs, events, diagnostics, sequence);
  const directAppendObserver = new DirectAppendObserver(persistence, sessions, ingestion);
  const { stopped } = await startDaemonServer({
    controlToken,
    controlApi: new ControlApi(sessions, runs, events, diagnostics),
    getActiveSessionCount: async () =>
      (await sessions.list()).filter((session) => session.status === "active").length,
    ingestApi: new IngestApi(ingestion),
    nonce: options.nonce,
    stateRoot: persistence.stateRoot,
  });
  directAppendObserver.start();
  try {
    await stopped;
  } finally {
    await directAppendObserver.stop();
  }
}
