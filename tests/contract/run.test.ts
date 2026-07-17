import { describe, expect, test } from "bun:test";
import { createRun } from "../../src/domain/run";

describe("run contract", () => {
  test("hypothesis declarations cannot change after run creation", () => {
    const run = createRun({
      createdAt: 1_784_313_600_000,
      hypothesisIds: ["H1", "H2"],
      id: "baseline",
    });

    expect(() => {
      (run.hypothesisIds as string[]).push("H3");
    }).toThrow();
    expect(run.hypothesisIds).toEqual(["H1", "H2"]);
  });
});
