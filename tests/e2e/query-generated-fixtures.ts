import type { NormalizedEvent } from "../../src/domain/event";

export interface GeneratedData {
  nested: {
    active: boolean;
    label: string;
    optional: null;
    score: number;
  };
  numbers: number[];
  tags: string[];
  text: string;
}

export type GeneratedEvent = Omit<NormalizedEvent, "data"> & { data: GeneratedData };

export interface GeneratedQueryCase {
  expected: (events: GeneratedEvent[]) => unknown[];
  limit: number;
  name: string;
  program: string;
  slurp: boolean;
}

class SeededPrng {
  private state: number;

  constructor(seed: number) {
    this.state = seed || 0x9e3779b9;
  }

  nextUint32(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  pick<T>(values: readonly T[]): T {
    return values[this.nextUint32() % values.length] as T;
  }
}

const TEXTS = ["", "héllo 🌍", "a.*[b]?", 'quotes " and slash \\', "line\\nbreak"] as const;
const LOCATIONS = [
  "src/(core)/agent.ts:10",
  "src/(core)/agent.ts:11",
  "lib/[edge].ts:2",
  "packages/über/file.ts:3",
] as const;
const MESSAGES = [
  "ok",
  "error[42] synthetic",
  "punctuation .*? + (test)",
  "Unicode café 🚀",
  "",
] as const;
const SCORES = [-999, -10.5, 0, 1.25, 42, 1_000_000] as const;
const TIMESTAMP_DELTAS = [0, 2, 1, 2, -1, 0, 3] as const;
const HYPOTHESES = ["H1", "H2", "H3"] as const;
const TAG_SETS = [[], ["alpha"], ["βeta", "a.*"], ["", "punctuation!?"]] as const;
const NUMBER_SETS = [[], [0, -1, 1.5], [1_000_000, -999, 0.25], [42]] as const;

export function configuredSeeds(): number[] {
  const replay = process.env.DEBUG_MODE_QUERY_FUZZ_SEED;
  if (replay !== undefined) {
    const parsed = Number(replay);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
      throw new Error("DEBUG_MODE_QUERY_FUZZ_SEED must be a 32-bit non-negative integer");
    }
    return [parsed];
  }
  return [0x00c0ffee, 0x1badb002, 0x5eed1234];
}

export function generateEvents(seed: number, count = 12): GeneratedEvent[] {
  const random = new SeededPrng(seed);
  const baseTimestamp = 1_784_310_000_000;
  return Array.from({ length: count }, (_, index) => {
    const sequence = index + 1;
    return {
      data: {
        nested: {
          active: random.pick([true, false] as const),
          label: random.pick(TEXTS),
          optional: null,
          score: random.pick(SCORES),
        },
        numbers: [...random.pick(NUMBER_SETS)],
        tags: index === 0 ? ["split-0", "split-1", "split-2", ""] : [...random.pick(TAG_SETS)],
        text: random.pick(TEXTS),
      },
      hypothesisId: HYPOTHESES[index % HYPOTHESES.length] as string,
      id: `generated-${seed.toString(16)}-${sequence}`,
      location: random.pick(LOCATIONS),
      message: random.pick(MESSAGES),
      receivedAt: baseTimestamp + sequence * 10,
      sequence,
      timestamp: baseTimestamp + (TIMESTAMP_DELTAS[index % TIMESTAMP_DELTAS.length] ?? 0),
    };
  });
}

function groupedCounts(events: GeneratedEvent[]): unknown[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.hypothesisId, (counts.get(event.hypothesisId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([hypothesisId, count]) => ({ count, hypothesisId }));
}

export const GENERATED_QUERY_CASES: GeneratedQueryCase[] = [
  {
    expected: (events) => events,
    limit: 4,
    name: "identity",
    program: ".",
    slurp: false,
  },
  {
    expected: (events) =>
      events.map(({ hypothesisId, id, sequence, timestamp }) => ({
        hypothesisId,
        id,
        sequence,
        timestamp,
      })),
    limit: 4,
    name: "projection",
    program: "{id, hypothesisId, timestamp, sequence}",
    slurp: false,
  },
  {
    expected: (events) => events.map((event) => event.data.nested.label),
    limit: 4,
    name: "nested-field",
    program: ".data.nested.label",
    slurp: false,
  },
  {
    expected: (events) =>
      events.filter((event) => event.data.nested.score < 0).map((event) => event.id),
    limit: 3,
    name: "numeric-predicate",
    program: "select(.data.nested.score < 0) | .id",
    slurp: false,
  },
  {
    expected: (events) => events.filter((event) => event.data.text === "").map((event) => event.id),
    limit: 3,
    name: "empty-string-predicate",
    program: 'select(.data.text == "") | .id',
    slurp: false,
  },
  {
    expected: (events) =>
      events.filter((event) => event.data.nested.active).map((event) => event.id),
    limit: 3,
    name: "boolean-predicate",
    program: "select(.data.nested.active == true) | .id",
    slurp: false,
  },
  {
    expected: (events) =>
      events.filter((event) => event.data.nested.optional === null).map((event) => event.id),
    limit: 4,
    name: "null-predicate",
    program: "select(.data.nested.optional == null) | .id",
    slurp: false,
  },
  {
    expected: (events) =>
      events.filter((event) => event.hypothesisId === "H2").map((event) => event.id),
    limit: 3,
    name: "hypothesis-filter",
    program: 'select(.hypothesisId == "H2") | .id',
    slurp: false,
  },
  {
    expected: (events) =>
      events
        .filter((event) => /^src\/\(core\)/.test(event.location))
        .map((event) => event.location),
    limit: 3,
    name: "location-regex",
    program: String.raw`select(.location | test("^src/\\(core\\)")) | .location`,
    slurp: false,
  },
  {
    expected: (events) =>
      events.filter((event) => /error\[[0-9]+\]/.test(event.message)).map((event) => event.id),
    limit: 3,
    name: "message-regex",
    program: String.raw`select(.message | test("error\\[[0-9]+\\]")) | .id`,
    slurp: false,
  },
  {
    expected: (events) => events.map((event) => event.data.numbers.map((value) => value * 2)),
    limit: 4,
    name: "array-transform",
    program: ".data.numbers | map(. * 2)",
    slurp: false,
  },
  {
    expected: (events) => events.flatMap((event) => event.data.tags),
    limit: 2,
    name: "per-input-output-ordinal",
    program: ".data.tags[]",
    slurp: false,
  },
  {
    expected: (events) =>
      [...events]
        .sort((left, right) => left.timestamp - right.timestamp || left.sequence - right.sequence)
        .map((event) => event.id),
    limit: 3,
    name: "timestamp-sequence-order",
    program: "sort_by([.timestamp, .sequence]) | .[] | .id",
    slurp: true,
  },
  {
    expected: groupedCounts,
    limit: 2,
    name: "group-count",
    program: "group_by(.hypothesisId) | .[] | {hypothesisId: .[0].hypothesisId, count: length}",
    slurp: true,
  },
  {
    expected: (events) => {
      const scores = events.map((event) => event.data.nested.score);
      return [
        {
          maximum: Math.max(...scores),
          minimum: Math.min(...scores),
          total: scores.reduce((sum, score) => sum + score, 0),
        },
      ];
    },
    limit: 2,
    name: "numeric-aggregation",
    program: "map(.data.nested.score) | {minimum: min, maximum: max, total: add}",
    slurp: true,
  },
];
