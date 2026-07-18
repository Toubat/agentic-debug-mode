import { createHash } from "node:crypto";
import { type FileHandle, open } from "node:fs/promises";
import { MAX_INGESTION_RECORD_BYTES } from "../domain/ingestion";
import { readJsonFile, writeJsonAtomic } from "../platform/atomic-file";
import type { IngestionService } from "./ingest-api";
import type { Persistence } from "./persistence";
import type { SessionRegistry } from "./session-registry";

const MAX_READ_BYTES = 256 * 1024;
const POLL_INTERVAL_MILLISECONDS = 50;

interface IncomingCursor {
  offset: number;
}

export interface DirectAppendObserverHooks {
  afterEventAppend?(): Promise<void>;
}

function directAppendEventId(sessionId: string, offset: number, line: Buffer): string {
  const digest = createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(String(offset))
    .update("\0")
    .update(line)
    .digest("hex");
  return `evt_${digest}`;
}

export class DirectAppendObserver {
  private interval: ReturnType<typeof setInterval> | undefined;
  private lastError: Error | undefined;
  private tickPromise: Promise<void> | undefined;

  constructor(
    private readonly persistence: Persistence,
    private readonly sessions: SessionRegistry,
    private readonly ingestion: IngestionService,
    private readonly hooks: DirectAppendObserverHooks = {},
  ) {}

  get error(): Error | undefined {
    return this.lastError;
  }

  start(): void {
    if (this.interval) {
      return;
    }
    this.interval = setInterval(() => {
      if (!this.tickPromise) {
        this.tickPromise = this.tick()
          .catch((error: unknown) => {
            this.lastError = error instanceof Error ? error : new Error(String(error));
          })
          .finally(() => {
            this.tickPromise = undefined;
          });
      }
    }, POLL_INTERVAL_MILLISECONDS);
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    await this.tickPromise;
  }

  private async tick(): Promise<void> {
    const sessions = await this.sessions.list({ all: true });
    await Promise.all(sessions.map((session) => this.processSession(session.id)));
  }

  private async processSession(sessionId: string): Promise<void> {
    await this.persistence.runSessionOperation(sessionId, () =>
      this.processSessionWhileLocked(sessionId),
    );
  }

  private async processSessionWhileLocked(sessionId: string): Promise<void> {
    const cursorPath = this.persistence.sessionFile(sessionId, "incoming.cursor.json");
    const cursor = await this.readCursor(cursorPath);
    const incoming = await open(this.persistence.sessionFile(sessionId, "incoming.ndjson"), "r");
    try {
      const stats = await incoming.stat();
      const offset =
        Number.isSafeInteger(cursor.offset) && cursor.offset >= 0 && cursor.offset <= stats.size
          ? cursor.offset
          : 0;
      const available = stats.size - offset;
      if (available === 0) {
        if (offset !== cursor.offset) {
          await writeJsonAtomic(cursorPath, { offset });
        }
        return;
      }
      const buffer = Buffer.alloc(Math.min(available, MAX_READ_BYTES));
      const { bytesRead } = await incoming.read(buffer, 0, buffer.length, offset);
      const contents = buffer.subarray(0, bytesRead);
      const finalNewline = contents.lastIndexOf(0x0a);
      if (finalNewline < 0) {
        if (available > MAX_INGESTION_RECORD_BYTES) {
          const recordEnd = await this.findRecordEnd(incoming, offset + bytesRead, stats.size);
          if (recordEnd !== undefined) {
            await this.ingestion.ingestRecord(sessionId, contents.toString("utf8"));
            await writeJsonAtomic(cursorPath, { offset: recordEnd });
          }
        }
        return;
      }
      const complete = contents.subarray(0, finalNewline + 1);
      let relativeOffset = 0;
      while (relativeOffset < complete.byteLength) {
        const newline = complete.indexOf(0x0a, relativeOffset);
        if (newline < 0) {
          break;
        }
        const line = complete.subarray(relativeOffset, newline);
        if (line.byteLength > 0) {
          const result = await this.ingestion.ingestRecord(sessionId, line.toString("utf8"), {
            eventId: directAppendEventId(sessionId, offset + relativeOffset, line),
          });
          switch (result) {
            case "accepted":
              await this.hooks.afterEventAppend?.();
              break;
            case "invalid":
            case "too-large":
              break;
            case "not-found":
              return;
            default: {
              const exhaustive: never = result;
              throw new Error(`Unhandled ingestion result: ${exhaustive}`);
            }
          }
        }
        relativeOffset = newline + 1;
      }
      await writeJsonAtomic(cursorPath, {
        offset: offset + complete.byteLength,
      });
    } finally {
      await incoming.close();
    }
  }

  private async findRecordEnd(
    file: FileHandle,
    start: number,
    size: number,
  ): Promise<number | undefined> {
    let position = start;
    const buffer = Buffer.alloc(MAX_READ_BYTES);
    while (position < size) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, size - position),
        position,
      );
      if (bytesRead === 0) {
        return undefined;
      }
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
      if (newline >= 0) {
        return position + newline + 1;
      }
      position += bytesRead;
    }
    return undefined;
  }

  private async readCursor(path: string): Promise<IncomingCursor> {
    try {
      const cursor = await readJsonFile<IncomingCursor>(path);
      if (Number.isSafeInteger(cursor.offset) && cursor.offset >= 0) {
        return cursor;
      }
    } catch (error) {
      if (
        !(
          error instanceof SyntaxError ||
          (error instanceof Error && "code" in error && error.code === "ENOENT")
        )
      ) {
        throw error;
      }
    }
    return { offset: 0 };
  }
}
