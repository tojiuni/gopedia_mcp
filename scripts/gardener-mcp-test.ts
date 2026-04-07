/**
 * Verifies Gardener MCP tools are registered and optionally calls gardener_health.
 * Full gardener_quality_run requires Gopedia + Gardener + dataset path; run manually when services are up.
 */
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function getText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return String(result);
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content)) return String(result);
  const t = content.find((c) => c?.type === "text" && typeof c?.text === "string");
  return t?.text ?? "";
}

async function main() {
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

  const client = new Client({ name: "gardener-mcp-test", version: "1.0.0" });
  await client.connect(transport);

  try {
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    const required = ["gardener_health", "gardener_quality_run", "gardener_run_report"];
    const missing = required.filter((n) => !names.includes(n));
    if (missing.length) {
      console.error("Missing tools:", missing.join(", "));
      console.error("Got:", names.join(", "));
      process.exit(1);
    }

    const gh = await client.callTool({
      name: "gardener_health",
      arguments: { gopedia_preflight: false },
    });
    const ghText = getText(gh);
    let ghJson: unknown;
    try {
      ghJson = JSON.parse(ghText);
    } catch {
      ghJson = ghText;
    }

    const prompts = await client.listPrompts();
    const promptNames = prompts.prompts.map((p) => p.name);
    if (!promptNames.includes("gardener_quality_guide")) {
      console.error("Missing prompt gardener_quality_guide. Got:", promptNames.join(", "));
      process.exit(1);
    }

    const bogusRun = await client.callTool({
      name: "gardener_run_report",
      arguments: { run_id: "00000000-0000-0000-0000-000000000001", failure_sample_limit: 2 },
    });
    let bogusParsed: Record<string, unknown>;
    try {
      bogusParsed = JSON.parse(getText(bogusRun)) as Record<string, unknown>;
    } catch {
      console.error("gardener_run_report did not return JSON");
      process.exit(1);
    }
    if (bogusParsed["ok"] !== false) {
      console.error("Expected gardener_run_report to mark ok:false for missing run id");
      process.exit(1);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          tools_gardener: required,
          gardener_health_sample: ghJson,
          gardener_run_report_missing_run_ok: bogusParsed["ok"] === false,
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
