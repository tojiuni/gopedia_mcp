/**
 * End-to-end: MCP gardener_quality_run (long-running).
 * Default: quality_preset "osteon" (Gardener loads bundled sample_osteon_guide_30_v2.json).
 * File mode: DATASET_JSON_PATH=/path/to/dataset.json USE_DATASET_FILE=1
 */
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

function getText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return String(result);
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content)) return String(result);
  const t = content.find((c) => c?.type === "text" && typeof c?.text === "string");
  return t?.text ?? "";
}

async function main() {
  const useFile = process.env.USE_DATASET_FILE === "1" || Boolean(process.env.DATASET_JSON_PATH?.trim());
  const datasetPath =
    process.env.DATASET_JSON_PATH?.trim() ??
    "/Users/dong-hoshin/Documents/dev/gardener_gopedia/dataset/sample_osteon_guide_30.json";
  const qualityPreset = process.env.QUALITY_PRESET?.trim() ?? "osteon";

  const apiBase =
    process.env.GOPEDIA_API_URL ??
    (process.env.GOPEDIA_HOST_DOMAIN
      ? /^https?:\/\//.test(process.env.GOPEDIA_HOST_DOMAIN)
        ? process.env.GOPEDIA_HOST_DOMAIN
        : `http://${process.env.GOPEDIA_HOST_DOMAIN}`
      : "http://127.0.0.1:18787");

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "gopedia-mcp-server.ts"],
    cwd: process.cwd(),
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string")
      ),
      GOPEDIA_API_URL: apiBase,
    },
    stderr: "pipe",
  });

  const client = new Client({ name: "gardener-quality-e2e", version: "1.0.0" });
  await client.connect(transport);

  try {
    const baseArgs: Record<string, unknown> = {
      gopedia_preflight: true,
      top_k: 10,
      search_detail: "summary",
      wait_timeout_ms: 400_000,
    };
    if (useFile) {
      Object.assign(baseArgs, {
        dataset_json_path: datasetPath,
        unique_dataset_name: true,
        resolve_before_eval: true,
      });
    } else {
      Object.assign(baseArgs, { quality_preset: qualityPreset });
    }

    const res = await client.callTool(
      {
        name: "gardener_quality_run",
        arguments: baseArgs,
      },
      CallToolResultSchema,
      { timeout: 450_000 }
    );
    const text = getText(res);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed["ok"]) {
      console.error(text);
      process.exit(1);
    }
    console.log(
      JSON.stringify(
        {
          ok: parsed["ok"],
          quality_preset: parsed["quality_preset"],
          dataset_id: parsed["dataset_id"],
          run_id: parsed["run_id"],
          aggregate_metrics: parsed["aggregate_metrics"],
          recall_at_5_zero_count: parsed["recall_at_5_zero_count"],
        },
        null,
        2
      )
    );
  } finally {
    await transport.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
