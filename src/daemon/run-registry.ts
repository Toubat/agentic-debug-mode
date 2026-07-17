import type { CreateRunInput, Run } from "../domain/run";
import { createRun } from "../domain/run";
import { readJsonFile, writeJsonAtomic } from "../platform/atomic-file";
import type { Persistence } from "./persistence";

function sameHypotheses(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((hypothesis, index) => hypothesis === right[index])
  );
}

export class RunRegistry {
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly persistence: Persistence) {}

  private async read(sessionId: string): Promise<Run[]> {
    const path = this.persistence.sessionFile(sessionId, "runs.json");
    const runs = await readJsonFile<Run[]>(path);
    return runs.map((run) =>
      createRun({
        createdAt: run.createdAt,
        hypothesisIds: [...run.hypothesisIds],
        id: run.id,
      }),
    );
  }

  async declare(sessionId: string, input: CreateRunInput): Promise<Run> {
    let declared: Run | undefined;
    const previous = this.writes.get(sessionId) ?? Promise.resolve();
    const write = previous.then(async () => {
      const runs = await this.read(sessionId);
      const existing = runs.find((run) => run.id === input.id);
      if (existing) {
        if (!sameHypotheses(existing.hypothesisIds, input.hypothesisIds)) {
          throw new Error(`Run ${input.id} already exists with immutable hypotheses`);
        }
        declared = existing;
        return;
      }

      declared = createRun(input);
      await writeJsonAtomic(this.persistence.sessionFile(sessionId, "runs.json"), [
        ...runs,
        declared,
      ]);
    });
    const queued = write.then(
      () => undefined,
      () => undefined,
    );
    this.writes.set(sessionId, queued);
    try {
      await write;
      if (!declared) {
        throw new Error(`Run ${input.id} was not declared`);
      }
      return declared;
    } finally {
      if (this.writes.get(sessionId) === queued) {
        this.writes.delete(sessionId);
      }
    }
  }

  async get(sessionId: string, runId: string): Promise<Run | undefined> {
    await (this.writes.get(sessionId) ?? Promise.resolve());
    return (await this.read(sessionId)).find((run) => run.id === runId);
  }
}
