import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { EnergyService } from "./service.js";
import { tariffSchema } from "./analysis.js";

export function createServer(service: EnergyService) {
  const server = new McpServer(
    { name: "energy-lens", version: "0.1.0" },
    {
      instructions:
        "Read-only UK electricity analysis. Start with meter_status; list_meters discovers verified Glow resources. sync_history downloads only the user-requested period to a private local cache. Dates are UK calendar dates, from inclusive and to exclusive. Never ask for account passwords in chat. Get tariff prices from the user or configured rates; never invent them. Report coverage and distinguish recorded costs from full bills. Do not annualise incomplete samples or identify EV/appliance use without separate evidence. Scenario tariffs are counterfactual; historical bills require dated rates.",
    },
  );
  const range = {
    from: z.string().describe("Inclusive UK calendar date YYYY-MM-DD"),
    to: z.string().describe("Exclusive UK calendar date YYYY-MM-DD"),
    stream: z.string().optional(),
  };
  const mode = z.enum(["scenario", "historical"]).default("scenario");
  const result = async (action: () => unknown | Promise<unknown>) => {
    try {
      const data = await action();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: data as Record<string, unknown>,
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              error instanceof z.ZodError
                ? "Invalid data or arguments. Check the documented schema and units."
                : error instanceof Error
                  ? error.message
                  : "The request failed.",
          },
        ],
      };
    }
  };
  const read = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  server.registerTool(
    "meter_status",
    {
      description:
        "Show locally saved meters, data dates, latest CAD readings and configured tariff IDs.",
      inputSchema: z.object({}),
      annotations: read,
    },
    () => result(() => service.status()),
  );
  server.registerTool(
    "list_meters",
    {
      description:
        "Find verified electricity meters in your own Bright/Glow account; requires configured credentials.",
      inputSchema: z.object({}),
      annotations: { ...read, openWorldHint: true },
    },
    (_args, extra) =>
      result(async () => ({
        meters: await service.meters(extra.mcpReq.signal),
      })),
  );
  server.registerTool(
    "sync_history",
    {
      description:
        "Download available half-hourly electricity history into the local cache. Defaults to the preceding 13 months plus current month up to yesterday. Missing history is retried; no readings are fabricated. Reads Glow and writes only the private cache.",
      inputSchema: z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        resourceId: z.string().optional(),
        refresh: z.boolean().default(false),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args, extra) => result(() => service.sync(args, extra.mcpReq.signal)),
  );
  server.registerTool(
    "get_usage",
    {
      description:
        "Summarise saved electricity consumption, missing intervals and coverage. Half-hour results are paginated; totals cover the full requested range.",
      inputSchema: z.object({
        ...range,
        interval: z.enum(["half_hour", "day", "month"]).default("day"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(1000).default(100),
      }),
      annotations: read,
    },
    (args) => result(() => service.usage(args)),
  );
  server.registerTool(
    "calculate_cost",
    {
      description:
        "Calculate energy and standing charges using explicit VAT-inclusive pence rates. Historical mode requires dated tariff periods; scenario mode reapplies supplied prices to recorded usage.",
      inputSchema: z.object({
        ...range,
        tariff: tariffSchema.optional(),
        tariffId: z.string().optional(),
        mode,
      }),
      annotations: read,
    },
    (args) => result(() => service.cost(args)),
  );
  server.registerTool(
    "compare_tariffs",
    {
      description:
        "Compare 2–10 tariffs over the same recorded usage. Returns costs and savings against the baseline; never estimates missing usage or annual savings.",
      inputSchema: z.object({
        ...range,
        tariffs: z.array(tariffSchema).min(2).max(10).optional(),
        baselineId: z.string().optional(),
        mode,
      }),
      annotations: read,
    },
    (args) => result(() => service.compare(args)),
  );
  return server;
}

export async function serve(service = new EnergyService()) {
  const server = createServer(service);
  const close = async () => {
    await server.close();
    service.store.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  await server.connect(new StdioServerTransport());
}
