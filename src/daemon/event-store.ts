import { createReadStream } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { NormalizedEvent } from "../domain/event";
import { writeTextAtomic } from "../platform/atomic-file";
import type { Persistence } from "./persistence";

export interface EventPageOptions {
  hypothesisIds: string[];
  limit: number;
  offset: number;
  watermark?: number;
}

export interface EventPage {
  records: NormalizedEvent[];
  recordsByHypothesis: Record<string, number>;
  totalRecords: number;
  watermark: number;
}

export class EventStore {
  private readonly knownIds = new Map<string, Set<string>>();

  constructor(private readonly persistence: Persistence) {}

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

  async readPage(sessionId: string, options: EventPageOptions): Promise<EventPage> {
    return this.runSessionOperation(sessionId, async () => {
      const records: NormalizedEvent[] = [];
      const recordsByHypothesis: Record<string, number> = {};
      let totalRecords = 0;
      let watermark = options.watermark ?? 0;
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
        if (totalRecords >= options.offset && records.length < options.limit) {
          records.push(event);
        }
        totalRecords += 1;
      }
      return { records, recordsByHypothesis, totalRecords, watermark };
    });
  }
}
