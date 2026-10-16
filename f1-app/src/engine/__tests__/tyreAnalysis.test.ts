
import { describe, it, expect } from "vitest";
import { loadFixture } from "./fixtures.ts";
import { buildSessionModel } from "../session/build.ts";
import { compoundSummary } from "../analyses/degradation.ts";
import { tyreLife } from "../analyses/tyreLife.ts";

describe("tyre analysis data quality", () => {

it("normalizes a missing tyre compound to UNKNOWN", () => {
  const fixture = loadFixture("miami-2026-race");
  const stints = fixture.inputs.stints;

  if (!stints || stints.length === 0) {
    throw new Error("Miami race fixture has no stints");
  }

  const firstStint = stints[0];

  stints[0] = {
    ...firstStint,
    compound: "",
  };

  const model = buildSessionModel(fixture.inputs);

  const normalizedStint = model.drivers
    .find(d => d.driver.driver_number === firstStint.driver_number)
    ?.stints.find(s => s.stint_number === firstStint.stint_number);

  expect(normalizedStint?.compound).toBe("UNKNOWN");
});


  it("does not report tyre-life curves for a qualifying session", () => {
    const fixture = loadFixture("suzuka-2026-quali");
    const model = buildSessionModel(fixture.inputs);

    const result = tyreLife(model);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("wrong_session_kind");
    }
  });

  it("returns finite values whenever compound summaries are available", () => {
    const fixture = loadFixture("miami-2026-race");
    const model = buildSessionModel(fixture.inputs);
    const result = compoundSummary(model);

    if (result.ok) {
      for (const summary of result.value) {
        expect(Number.isFinite(summary.medianDeg)).toBe(true);
        expect(Number.isFinite(summary.medianStintLength)).toBe(true);
        if (summary.medianPace !== null) {
          expect(Number.isFinite(summary.medianPace)).toBe(true);
        }
      }
    }
  });
});
