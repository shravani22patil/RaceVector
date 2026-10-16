import { describe, expect, it } from "vitest";
import type { AnalysisFacts } from "../../engine/index.ts";
import { AGENT_TOOLS, executeAgentTool } from "../agent-tools.ts";

const fixture = {
  coverage: {
    stints: true,
    pits: true,
    intervals: false,
    position: true,
    raceControl: true,
    results: true,
    weather: false,
    startingGrid: true,
    overtakes: false,
  },
  tables: {
    results: [
      { pos: 1, driver: "VER", team: "Apex GP", grid: 2, status: "finished", gap: 0 },
      { pos: 2, driver: "NOR", team: "Summit Racing", grid: 1, status: "finished", gap: 1.234 },
    ],
    pace: [
      { rank: 1, driver: "VER", median: 91.234, fuelCorrected: 91.111, gap: 0, n: 18 },
      { rank: 2, driver: "NOR", median: 91.555, fuelCorrected: 91.432, gap: 0.321, n: 17 },
    ],
    pitStops: {
      metric: "lane",
      pitLoss: 22.4,
      teams: [{ team: "Apex GP", stops: 3, median: 2.4, best: 2.1, underSC: 0 }],
    },
    weather: null,
  },
} satisfies Pick<AnalysisFacts, "coverage" | "tables">;

function callTool(name: string, args?: unknown): unknown {
  const output = executeAgentTool(name, args === undefined ? undefined : JSON.stringify(args), fixture.tables);
  return JSON.parse(output) as unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rowsFor(table: string): Record<string, unknown>[] {
  const result = callTool("inspect_race_table", { table });
  if (!isObject(result) || !Array.isArray(result.items)) throw new Error(`Expected rows for ${table}; got ${JSON.stringify(result)}`);
  return result.items.filter(isObject);
}

describe("RaceVector agent baseline evaluation", () => {
  it("returns the fixture's actual race winner and finishing positions", () => {
    const rows = rowsFor("results");
    expect(rows[0]?.driver).toBe("VER");
    expect(rows[0]?.pos).toBe(1);
    expect(rows[1]?.driver).toBe("NOR");
    expect(rows[1]?.pos).toBe(2);
  });

  it("reports pace gap against the deterministic expected value within 1 ms", () => {
    const rows = rowsFor("pace");
    const first = rows[0]?.fuelCorrected;
    const second = rows[1]?.fuelCorrected;
    expect(typeof first).toBe("number");
    expect(typeof second).toBe("number");
    if (typeof first !== "number" || typeof second !== "number") throw new Error("Fixture pace values must be numeric");
    const actualGap = second - first;
    expect(actualGap).toBeCloseTo(0.321, 3);
  });

  it("exposes list and inspect tools and retrieves the relevant race table", () => {
    const toolNames = AGENT_TOOLS.map(tool => tool.function.name);
    expect(toolNames).toEqual(["list_race_tables", "inspect_race_table"]);
    expect(callTool("list_race_tables")).toEqual(["results", "pace", "pitStops", "weather"]);
    expect(rowsFor("pace")[1]?.driver).toBe("NOR");
  });

  it("identifies an unavailable metric instead of returning fabricated rows", () => {
    expect(fixture.coverage.intervals).toBe(false);
    expect(callTool("inspect_race_table", { table: "dirtyAir" })).toEqual({
      error: "Unknown table. Call list_race_tables to see available tables.",
    });
  });

  it("preserves aggregated pit-stop summaries without inventing individual stops", () => {
    const result = callTool("inspect_race_table", { table: "pitStops" });
    expect(result).toEqual({
      table: "pitStops",
      totalItems: 1,
      items: [{
        metric: "lane",
        pitLoss: 22.4,
        teams: [{ team: "Apex GP", stops: 3, median: 2.4, best: 2.1, underSC: 0 }],
      }],
    });
    expect(JSON.stringify(result)).not.toMatch(/driverNumber|driver_number|lap_number/);
  });

  it("returns no result when a search names a driver absent from the fixture", () => {
    const result = callTool("inspect_race_table", { table: "results", search: "ALONSO" });
    expect(result).toEqual({ table: "results", totalItems: 0, items: [] });
  });

  it("does not expose an unsupported fastest-lap claim when no such table is supplied", () => {
    expect(callTool("list_race_tables")).not.toContain("fastestLap");
    expect(callTool("inspect_race_table", { table: "fastestLap" })).toEqual({
      error: "Unknown table. Call list_race_tables to see available tables.",
    });
  });

  it("handles malformed arguments and unsupported tool calls with explicit errors", () => {
    expect(JSON.parse(executeAgentTool("inspect_race_table", "{", fixture.tables))).toEqual({
      error: "Unknown table. Call list_race_tables to see available tables.",
    });
    expect(callTool("not_a_tool", {})).toEqual({ error: "Unknown tool." });
  });
});
