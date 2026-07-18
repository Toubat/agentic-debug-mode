import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import type { NormalizedEvent } from "../domain/event";
import type { Session } from "../domain/session";
import { readJsonFile, writeTextAtomic } from "../platform/atomic-file";
import type { Persistence } from "./persistence";

export interface EventPageOptions {
  evidenceEpoch?: string;
  hypothesisIds: string[];
  limit: number;
  offset: number;
  watermark?: number;
}

export interface EventPage {
  evidenceEpoch: string;
  records: NormalizedEvent[];
  recordsByHypothesis: Record<string, number>;
  totalRecords: number;
  watermark: number;
}

export class EvidenceEpochMismatchError extends Error {
  readonly code = "CURSOR_STALE";

  constructor() {
    super("Evidence cursor is stale because the session was reset.");
    this.name = "EvidenceEpochMismatchError";
  }
}

export interface EventStoreOptions {
  sortChunkSize?: number;
  sortedReaderHooks?: SortedReaderHooks;
}

export interface SortedReaderHooks {
  failOpenAt?: number;
  onClose?: () => void;
  onOpen?: () => void;
}

export interface EventSummary {
  eventCount: number;
  watermark: number;
}

const DEFAULT_SORT_CHUNK_SIZE = 512;
const MERGE_FAN_IN = 32;

function compareEvents(left: NormalizedEvent, right: NormalizedEvent): number {
  return (
    left.timestamp - right.timestamp ||
    left.sequence - right.sequence ||
    left.id.localeCompare(right.id)
  );
}

class SortedEventReader {
  private closePromise: Promise<void> | undefined;
  private readonly lines;
  private readonly iterator;
  private readonly stream: ReadStream;
  current: NormalizedEvent | undefined;

  constructor(
    path: string,
    private readonly hooks?: SortedReaderHooks,
  ) {
    this.stream = createReadStream(path, { encoding: "utf8" });
    this.lines = createInterface({
      crlfDelay: Number.POSITIVE_INFINITY,
      input: this.stream,
    });
    this.iterator = this.lines[Symbol.asyncIterator]();
    this.hooks?.onOpen?.();
  }

  async advance(): Promise<void> {
    const next = await this.iterator.next();
    this.current = next.done ? undefined : (JSON.parse(next.value) as NormalizedEvent);
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = (async () => {
        this.lines.close();
        this.stream.destroy();
        await finished(this.stream).catch(() => undefined);
        this.hooks?.onClose?.();
      })();
    }
    await this.closePromise;
  }
}

function nextReader(readers: SortedEventReader[]): SortedEventReader | undefined {
  let selected: SortedEventReader | undefined;
  for (const reader of readers) {
    if (
      reader.current &&
      (!selected?.current || compareEvents(reader.current, selected.current) < 0)
    ) {
      selected = reader;
    }
  }
  return selected;
}

export class EventStore {
  private readonly knownIds = new Map<string, Set<string>>();
  private readonly sortChunkSize: number;
  private readonly sortedReaderHooks: SortedReaderHooks | undefined;

  constructor(
    private readonly persistence: Persistence,
    options: EventStoreOptions = {},
  ) {
    this.sortChunkSize = options.sortChunkSize ?? DEFAULT_SORT_CHUNK_SIZE;
    this.sortedReaderHooks = options.sortedReaderHooks;
    if (!Number.isSafeInteger(this.sortChunkSize) || this.sortChunkSize < 1) {
      throw new Error("Event sort chunk size must be a positive safe integer");
    }
  }

  runSessionOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.persistence.runSessionOperation(sessionId, operation);
  }

  private async readFile(sessionId: string): Promise<NormalizedEvent[]> {
    const contents = await readFile(
      this.persistence.sessionFile(sessionId, "events.ndjson"),
      "utf8",
    );
    return contents
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as NormalizedEvent);
  }

  async hasId(sessionId: string, eventId: string): Promise<boolean> {
    return this.runSessionOperation(sessionId, async () => {
      let ids = this.knownIds.get(sessionId);
      if (!ids) {
        ids = new Set((await this.readFile(sessionId)).map((item) => item.id));
        this.knownIds.set(sessionId, ids);
      }
      return ids.has(eventId);
    });
  }

  async append(sessionId: string, event: NormalizedEvent): Promise<boolean> {
    let appended = false;
    await this.runSessionOperation(sessionId, async () => {
      let ids = this.knownIds.get(sessionId);
      if (!ids) {
        ids = new Set((await this.readFile(sessionId)).map((item) => item.id));
        this.knownIds.set(sessionId, ids);
      }
      if (ids.has(event.id)) {
        return;
      }
      await appendFile(
        this.persistence.sessionFile(sessionId, "events.ndjson"),
        `${JSON.stringify(event)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      ids.add(event.id);
      appended = true;
    });
    return appended;
  }

  async clear(sessionId: string): Promise<void> {
    await this.runSessionOperation(sessionId, async () => {
      this.knownIds.set(sessionId, new Set());
      await writeTextAtomic(this.persistence.sessionFile(sessionId, "events.ndjson"), "");
    });
  }

  async read(sessionId: string): Promise<NormalizedEvent[]> {
    return this.runSessionOperation(sessionId, () => this.readFile(sessionId));
  }

  async summarize(sessionId: string): Promise<EventSummary> {
    return this.runSessionOperation(sessionId, async () => {
      let eventCount = 0;
      let watermark = 0;
      const lines = createInterface({
        crlfDelay: Number.POSITIVE_INFINITY,
        input: createReadStream(this.persistence.sessionFile(sessionId, "events.ndjson"), {
          encoding: "utf8",
        }),
      });
      for await (const line of lines) {
        if (!line) {
          continue;
        }
        try {
          const event = JSON.parse(line) as NormalizedEvent;
          eventCount += 1;
          watermark = Math.max(watermark, event.sequence);
        } catch {
          // Native query execution reports canonical corruption with its stable typed marker.
        }
      }
      return { eventCount, watermark };
    });
  }

  private async writeSortedChunk(path: string, events: NormalizedEvent[]): Promise<void> {
    events.sort(compareEvents);
    await writeFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }

  private async openSortedReaders(paths: string[]): Promise<SortedEventReader[]> {
    const readers: SortedEventReader[] = [];
    try {
      for (const [index, path] of paths.entries()) {
        if (this.sortedReaderHooks?.failOpenAt === index) {
          throw new Error("Injected sorted reader open failure");
        }
        const reader = new SortedEventReader(path, this.sortedReaderHooks);
        readers.push(reader);
        await reader.advance();
      }
      return readers;
    } catch (error) {
      await Promise.all(readers.map((reader) => reader.close()));
      throw error;
    }
  }

  private async mergeSortedFiles(inputPaths: string[], outputPath: string): Promise<void> {
    const readers = await this.openSortedReaders(inputPaths);
    const output = createWriteStream(outputPath, {
      encoding: "utf8",
      flags: "wx",
      mode: 0o600,
    });
    try {
      while (true) {
        const selected = nextReader(readers);
        if (!selected?.current) {
          break;
        }
        if (!output.write(`${JSON.stringify(selected.current)}\n`)) {
          await once(output, "drain");
        }
        await selected.advance();
      }
      output.end();
      await finished(output);
    } finally {
      await Promise.all(readers.map((reader) => reader.close()));
      if (!output.closed) {
        output.destroy();
      }
    }
  }

  private async readMergedPage(
    paths: string[],
    offset: number,
    limit: number,
  ): Promise<NormalizedEvent[]> {
    const readers = await this.openSortedReaders(paths);
    const records: NormalizedEvent[] = [];
    let index = 0;
    try {
      while (records.length < limit) {
        const selected = nextReader(readers);
        if (!selected?.current) {
          break;
        }
        if (index >= offset) {
          records.push(selected.current);
        }
        index += 1;
        await selected.advance();
      }
      return records;
    } finally {
      await Promise.all(readers.map((reader) => reader.close()));
    }
  }

  async readPage(sessionId: string, options: EventPageOptions): Promise<EventPage> {
    return this.runSessionOperation(sessionId, async () => {
      const session = await readJsonFile<Session>(
        this.persistence.sessionFile(sessionId, "session.json"),
      );
      if (options.evidenceEpoch && options.evidenceEpoch !== session.evidenceEpoch) {
        throw new EvidenceEpochMismatchError();
      }
      const operationId = randomUUID();
      await this.persistence.initializeLogSortOperation(sessionId, operationId);
      const recordsByHypothesis: Record<string, number> = {};
      let totalRecords = 0;
      let watermark = options.watermark ?? 0;
      let fileIndex = 0;
      let chunk: NormalizedEvent[] = [];
      let sortedPaths: string[] = [];
      try {
        const flushChunk = async () => {
          if (chunk.length === 0) {
            return;
          }
          const path = this.persistence.logSortFile(sessionId, operationId, `chunk-${fileIndex}`);
          fileIndex += 1;
          await this.writeSortedChunk(path, chunk);
          sortedPaths.push(path);
          chunk = [];
        };
        const lines = createInterface({
          crlfDelay: Number.POSITIVE_INFINITY,
          input: createReadStream(this.persistence.sessionFile(sessionId, "events.ndjson"), {
            encoding: "utf8",
          }),
        });
        for await (const line of lines) {
          if (!line) {
            continue;
          }
          const event = JSON.parse(line) as NormalizedEvent;
          if (options.watermark === undefined) {
            watermark = Math.max(watermark, event.sequence);
          } else if (event.sequence > options.watermark) {
            continue;
          }
          if (
            options.hypothesisIds.length > 0 &&
            !options.hypothesisIds.includes(event.hypothesisId)
          ) {
            continue;
          }
          recordsByHypothesis[event.hypothesisId] =
            (recordsByHypothesis[event.hypothesisId] ?? 0) + 1;
          totalRecords += 1;
          chunk.push(event);
          if (chunk.length === this.sortChunkSize) {
            await flushChunk();
          }
        }
        await flushChunk();

        while (sortedPaths.length > MERGE_FAN_IN) {
          const mergedPaths: string[] = [];
          for (let index = 0; index < sortedPaths.length; index += MERGE_FAN_IN) {
            const group = sortedPaths.slice(index, index + MERGE_FAN_IN);
            const outputPath = this.persistence.logSortFile(
              sessionId,
              operationId,
              `merge-${fileIndex}`,
            );
            fileIndex += 1;
            await this.mergeSortedFiles(group, outputPath);
            mergedPaths.push(outputPath);
          }
          sortedPaths = mergedPaths;
        }
        const records =
          sortedPaths.length === 0
            ? []
            : await this.readMergedPage(sortedPaths, options.offset, options.limit);
        return {
          evidenceEpoch: session.evidenceEpoch,
          records,
          recordsByHypothesis,
          totalRecords,
          watermark,
        };
      } finally {
        await this.persistence.clearLogSortOperation(sessionId, operationId);
      }
    });
  }
}
