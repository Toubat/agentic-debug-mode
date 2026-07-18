import { createHash } from "node:crypto";
import { type FileHandle, open } from "node:fs/promises";
import {
  directAppendDiagnosticId,
  directAppendEventId,
  directSourceContentHash,
  MAX_INGESTION_RECORD_BYTES,
  MAX_MALFORMED_PREVIEW_BYTES,
} from "../domain/ingestion";
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
  afterDiagnosticAppend?(): Promise<void>;
  afterEventAppend?(): Promise<void>;
  onRecordProcessed?(): void;
}

interface OversizedRecordScan {
  actualByteLength: number;
  contentHash: string;
  previewByteLength: number;
  recordEnd: number;
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
          const scan = await this.scanOversizedRecord(incoming, offset, stats.size);
          if (scan) {
            const result = await this.ingestion.ingestOversizedRecord(sessionId, {
              actualByteLength: scan.actualByteLength,
              diagnosticId: directAppendDiagnosticId(sessionId, offset, scan.contentHash),
              previewByteLength: scan.previewByteLength,
            });
            this.hooks.onRecordProcessed?.();
            if (result === "not-found") {
              return;
            }
            await this.hooks.afterDiagnosticAppend?.();
            await writeJsonAtomic(cursorPath, { offset: scan.recordEnd });
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
          const sourceOffset = offset + relativeOffset;
          const contentHash = directSourceContentHash(line);
          const diagnosticId = directAppendDiagnosticId(sessionId, sourceOffset, contentHash);
          const result =
            line.byteLength > MAX_INGESTION_RECORD_BYTES
              ? await this.ingestion.ingestOversizedRecord(sessionId, {
                  actualByteLength: line.byteLength,
                  diagnosticId,
                  previewByteLength: Math.min(line.byteLength, MAX_MALFORMED_PREVIEW_BYTES),
                })
              : await this.ingestion.ingestRecord(sessionId, line.toString("utf8"), {
                  actualByteLength: line.byteLength,
                  diagnosticId,
                  eventId: directAppendEventId(sessionId, sourceOffset, contentHash),
                  previewByteLength: Math.min(line.byteLength, MAX_MALFORMED_PREVIEW_BYTES),
                });
          this.hooks.onRecordProcessed?.();
          switch (result) {
            case "accepted":
              await this.hooks.afterEventAppend?.();
              break;
            case "invalid":
            case "malformed":
            case "too-large":
              await this.hooks.afterDiagnosticAppend?.();
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

  private async scanOversizedRecord(
    file: FileHandle,
    start: number,
    size: number,
  ): Promise<OversizedRecordScan | undefined> {
    let position = start;
    let actualByteLength = 0;
    let previewByteLength = 0;
    const hash = createHash("sha256");
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
      const recordBytes = buffer.subarray(0, newline >= 0 ? newline : bytesRead);
      hash.update(recordBytes);
      actualByteLength += recordBytes.byteLength;
      previewByteLength += Math.min(
        recordBytes.byteLength,
        MAX_MALFORMED_PREVIEW_BYTES - previewByteLength,
      );
      if (newline >= 0) {
        return {
          actualByteLength,
          contentHash: hash.digest("hex"),
          previewByteLength,
          recordEnd: position + newline + 1,
        };
      }
      position += recordBytes.byteLength;
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
