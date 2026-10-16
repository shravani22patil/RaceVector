export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_race_tables",
      description: "List the race-data tables available for this session.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_race_table",
      description:
        "Inspect a named table from the supplied session facts. Use this to retrieve evidence for race results, pace, tyres, pit stops, overtakes, sectors, weather, and strategy. Never invent table names or data.",
      parameters: {
        type: "object",
        properties: {
          table: {
            type: "string",
            description: "Exact table name returned by list_race_tables.",
          },
          search: {
            type: "string",
            description: "Optional case-insensitive text filter.",
          },
          limit: {
            type: "integer",
            description: "Maximum rows or items to return, from 1 to 20.",
          },
        },
        required: ["table"],
        additionalProperties: false,
      },
    },
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Execute a model-requested tool against the structured facts supplied to the agent. */
export function executeAgentTool(
  name: string,
  rawArguments: string | undefined,
  tables: Record<string, unknown>,
): string {
  let args: unknown = {};
  try {
    args = JSON.parse(rawArguments || "{}");
  } catch {
    args = {};
  }

  if (name === "list_race_tables") {
    return JSON.stringify(Object.keys(tables));
  }

  if (name === "inspect_race_table") {
    const tableName = isRecord(args) && typeof args.table === "string" ? args.table : "";

    if (!Object.prototype.hasOwnProperty.call(tables, tableName)) {
      return JSON.stringify({
        error: "Unknown table. Call list_race_tables to see available tables.",
      });
    }

    const raw = tables[tableName];
    const requestedLimit = isRecord(args) ? args.limit : undefined;
    const limit = Math.max(
      1,
      Math.min(20, typeof requestedLimit === "number" && Number.isInteger(requestedLimit) ? requestedLimit : 10),
    );
    const requestedSearch = isRecord(args) ? args.search : undefined;
    const search = typeof requestedSearch === "string" ? requestedSearch.toLowerCase().slice(0, 100) : "";

    let items = Array.isArray(raw) ? raw : [raw];
    if (search) {
      items = items.filter((item: unknown) =>
        JSON.stringify(item).toLowerCase().includes(search),
      );
    }

    return JSON.stringify({
      table: tableName,
      totalItems: items.length,
      items: items.slice(0, limit),
    }).slice(0, 6000);
  }

  return JSON.stringify({ error: "Unknown tool." });
}
