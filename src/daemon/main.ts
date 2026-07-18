import type { Clock } from "./activity";
import { getOrCreateControlToken } from "./auth";
import { ControlApi } from "./control-api";
import { DiagnosticStore } from "./diagnostic-store";
import { DirectAppendObserver } from "./direct-append-observer";
import { EventStore } from "./event-store";
import { IngestApi, IngestionService } from "./ingest-api";
import { Persistence } from "./persistence";
import type { DaemonMetadata, DaemonProcessIdentity } from "./protocol";
import { EventSequence } from "./sequence";
import { startDaemonServer } from "./server";
import { SessionRegistry } from "./session-registry";

export interface RunDaemonOptions {
  clock?: Clock;
  homeDirectory?: string;
  nonce: string;
  onStarted?(metadata: DaemonMetadata): void;
  processMetadata?: {
    pid: number;
    processIdentity: DaemonProcessIdentity;
  };
}

export async function runDaemon(options: RunDaemonOptions): Promise<void> {
  const persistence = await Persistence.open(options.homeDirectory);
  const controlToken = await getOrCreateControlToken(persistence.stateRoot);
  const events = new EventStore(persistence);
  const diagnostics = new DiagnosticStore(persistence);
  const sequence = new EventSequence(events);
  const sessions = new SessionRegistry(persistence, events, diagnostics, sequence);
  const ingestion = new IngestionService(sessions, events, diagnostics, sequence);
  const { activity, metadata, stopped } = await startDaemonServer({
    clock: options.clock,
    controlToken,
    controlApi: new ControlApi(sessions, events, diagnostics),
    getActiveSessionCount: async () => (await sessions.list({ all: true })).length,
    ingestApi: new IngestApi(ingestion),
    nonce: options.nonce,
    processMetadata: options.processMetadata,
    stateRoot: persistence.stateRoot,
  });
  const directAppendObserver = new DirectAppendObserver(persistence, sessions, ingestion, {
    onCompleteRecordObserved() {
      activity.touch();
    },
  });
  directAppendObserver.start();
  options.onStarted?.(metadata);
  try {
    await stopped;
  } finally {
    await directAppendObserver.stop();
  }
}
