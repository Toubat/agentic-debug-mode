export interface Run {
  readonly id: string;
  readonly createdAt: number;
  readonly hypothesisIds: readonly string[];
}

export interface CreateRunInput {
  id: string;
  createdAt: number;
  hypothesisIds: string[];
}

export function createRun(input: CreateRunInput): Run {
  return Object.freeze({
    createdAt: input.createdAt,
    hypothesisIds: Object.freeze([...input.hypothesisIds]),
    id: input.id,
  });
}
