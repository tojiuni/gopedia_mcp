/**
 * agent-e2e-test.ts
 *
 * End-to-end test that verifies Claude autonomously uses gopedia MCP tools
 * to answer questions — the full agent loop:
 *
 *   user question
 *     → Claude decides which tools to call and in what order
 *     → tool calls are proxied to the live Gopedia API
 *     → Claude synthesises a grounded answer
 *     → test checks the answer contains expected content
 *
 * The agent is primed with the gopedia_agent_guide prompt so escalation
 * behaviour (summary → standard → restore) is tested end-to-end.
 *
 * Logs:
 *   data/logs/agent-e2e-test-<timestamp>.json
 *   data/logs/agent-e2e-test-latest.md
 *
 * Environment:
 *   ANTHROPIC_API_KEY   — required
 *   GOPEDIA_API_URL     — Gopedia HTTP base URL (default: http://127.0.0.1:18787)
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ── config ────────────────────────────────────────────────────────────────────

const GOPEDIA_BASE =
  process.env.GOPEDIA_API_URL ??
  (process.env.GOPEDIA_HOST_DOMAIN
    ? /^https?:\/\//.test(process.env.GOPEDIA_HOST_DOMAIN)
      ? process.env.GOPEDIA_HOST_DOMAIN
      : `http://${process.env.GOPEDIA_HOST_DOMAIN}`
    : "http://127.0.0.1:18787");

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 2048;
const MAX_TOOL_ROUNDS = 8; // safety limit per question

// ── gopedia tool definitions ──────────────────────────────────────────────────

const GOPEDIA_TOOLS: Anthropic.Tool[] = [
  {
    name: "gopedia_health",
    description:
      "Check Gopedia service health. Call this first to confirm the service is reachable before searching.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "gopedia_search",
    description: `Search the Gopedia knowledge graph.

## Escalation order — always start cheap
1. detail=summary  (default) — title, snippet, source_path, score. Stop here if sufficient.
2. detail=standard           — adds l2_id, l1_id, section_heading, breadcrumb. Use to get restore pointers.
3. detail=full               — adds surrounding_context.
4. gopedia_restore(l2_id)    — full section body. Use when snippet is not enough.
5. gopedia_restore(l1_id)    — full document. Use sparingly.

For comparison queries run independent searches per concept, collect l2_id pointers, then restore and synthesise.`,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query text" },
        detail: {
          type: "string",
          enum: ["summary", "standard", "full"],
          description: "Field preset — summary (default) | standard | full",
        },
        fields: {
          type: "string",
          description: "Comma-separated field names (overrides detail)",
        },
        project_id: {
          type: "number",
          description: "Filter to a specific project integer ID",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "gopedia_restore",
    description: `Restore full section (l2_id) or document (l1_id) body from PostgreSQL.
Provide exactly ONE of l2_id or l1_id. Always call after a search that returned the id.
Prefer l2_id (section) over l1_id (document) to keep response size small.`,
    input_schema: {
      type: "object",
      properties: {
        l2_id: { type: "string", description: "Section UUID from a prior search result" },
        l1_id: { type: "string", description: "Document UUID from a prior search result" },
        format: {
          type: "string",
          enum: ["json", "markdown"],
          description: "json (default) | markdown",
        },
      },
      required: [],
    },
  },
];

// ── gopedia_agent_guide system prompt ─────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI assistant with access to the Gopedia knowledge graph via tools.
Always follow the escalation ladder — stop as soon as you have enough context to answer.

## Escalation ladder (cheapest → most expensive)
1. gopedia_search(detail=summary)   → STOP if snippet is sufficient
2. gopedia_search(detail=standard)  → when l2_id/l1_id pointers are needed
3. gopedia_search(detail=full)      → when surrounding_context is required
4. gopedia_restore(l2_id)           → full section body
5. gopedia_restore(l1_id)           → full document (use sparingly)

## Rules
- Always call gopedia_health first.
- Never call gopedia_restore without a prior search that returned the id.
- For comparison queries: search each concept independently → restore top hits → synthesise.
- Every answer must include citations: [source_path § section_heading] (l2_id: <uuid>).
- Answer in the same language as the question.`;

// ── test scenarios ────────────────────────────────────────────────────────────

type Scenario = {
  id: string;
  difficulty: "simple" | "intermediate" | "advanced";
  question: string;
  expectedKeywords: string[];
  note: string;
};

const SCENARIOS: Scenario[] = [
  {
    id: "A1",
    difficulty: "simple",
    question: "gopedia를 핵심 키워드 하나로 표현하면 무엇인가?",
    expectedKeywords: ["지식 신경망"],
    note: "gopedia 핵심 키워드",
  },
  {
    id: "A2",
    difficulty: "simple",
    question: "neunexus에서 실시간 메시징과 사용자 알림을 담당하는 서비스 이름은?",
    expectedKeywords: ["Tinode"],
    note: "neunexus 실시간 메시징 서비스",
  },
  {
    id: "A3",
    difficulty: "intermediate",
    question:
      "gopedia에서 Leaf 데이터를 흡수하여 Rhizome 저장소로 끌어올리는 인게스션 흐름의 이름은?",
    expectedKeywords: ["xylem", "목질부"],
    note: "Xylem flow — tests escalation to standard/restore",
  },
  {
    id: "A4",
    difficulty: "intermediate",
    question:
      "gopedia가 RAG 토큰 비용 절감을 위해 문서를 구조화하는 계층 이름을 모두 나열하면?",
    expectedKeywords: ["L1", "L2", "L3"],
    note: "L1/L2/L3 hierarchy — tests multi-result synthesis",
  },
  {
    id: "A5",
    difficulty: "advanced",
    question:
      "gopedia Smart Sink에서 L3 데이터가 저장되는 두 개의 저장소는 무엇이며 각각의 역할은?",
    expectedKeywords: ["Qdrant", "ClickHouse"],
    note: "L3 stores — tests restore for deep context",
  },
];

// ── gopedia tool executor ─────────────────────────────────────────────────────

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  try {
    if (name === "gopedia_health") {
      const res = await fetch(`${GOPEDIA_BASE}/api/health/deps`);
      return await res.text();
    }

    if (name === "gopedia_search") {
      const params = new URLSearchParams({ q: String(input.query), format: "json" });
      params.set("detail", String(input.detail ?? "summary"));
      if (input.fields) params.set("fields", String(input.fields));
      if (input.project_id !== undefined) params.set("project_id", String(input.project_id));
      const res = await fetch(`${GOPEDIA_BASE}/api/search?${params}`);
      return await res.text();
    }

    if (name === "gopedia_restore") {
      const params = new URLSearchParams();
      if (input.l2_id) params.set("l2_id", String(input.l2_id));
      if (input.l1_id) params.set("l1_id", String(input.l1_id));
      params.set("format", String(input.format ?? "json"));
      const res = await fetch(`${GOPEDIA_BASE}/api/restore?${params}`);
      return await res.text();
    }

    return JSON.stringify({ error: `Unknown tool: ${name}` });
  } catch (err) {
    return JSON.stringify({ ok: false, failure: { code: "NETWORK_ERROR", message: String(err) } });
  }
}

// ── agent loop ────────────────────────────────────────────────────────────────

type ToolCall = { name: string; input: Record<string, unknown>; output: string };

type ScenarioResult = {
  id: string;
  difficulty: string;
  note: string;
  question: string;
  answer: string;
  toolCalls: ToolCall[];
  hitKeywords: string[];
  missedKeywords: string[];
  pass: boolean;
  durationMs: number;
  error?: string;
};

async function runScenario(client: Anthropic, scenario: Scenario): Promise<ScenarioResult> {
  const t0 = Date.now();
  const toolCalls: ToolCall[] = [];

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: scenario.question },
  ];

  let answer = "";
  let error: string | undefined;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: GOPEDIA_TOOLS,
        messages,
      });

      // Collect assistant message
      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "end_turn") {
        // Extract final text answer
        for (const block of response.content) {
          if (block.type === "text") answer += block.text;
        }
        break;
      }

      if (response.stop_reason === "tool_use") {
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const block of response.content) {
          if (block.type !== "tool_use") continue;

          const output = await executeTool(
            block.name,
            block.input as Record<string, unknown>
          );
          toolCalls.push({ name: block.name, input: block.input as Record<string, unknown>, output });
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: output });
        }

        messages.push({ role: "user", content: toolResults });
        continue;
      }

      // Unexpected stop reason
      break;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // Check keywords in the final answer (case-insensitive)
  const lowerAnswer = answer.toLowerCase();
  const hitKeywords = scenario.expectedKeywords.filter((k) =>
    lowerAnswer.includes(k.toLowerCase())
  );
  const missedKeywords = scenario.expectedKeywords.filter(
    (k) => !lowerAnswer.includes(k.toLowerCase())
  );

  return {
    id: scenario.id,
    difficulty: scenario.difficulty,
    note: scenario.note,
    question: scenario.question,
    answer,
    toolCalls,
    hitKeywords,
    missedKeywords,
    pass: !error && missedKeywords.length === 0,
    durationMs: Date.now() - t0,
    error,
  };
}

// ── markdown report ───────────────────────────────────────────────────────────

function buildMarkdown(results: ScenarioResult[], startedAt: string, finishedAt: string): string {
  const lines: string[] = [];
  lines.push("# Agent E2E Test Report — Claude × Gopedia MCP");
  lines.push("");
  lines.push(`- **Model**: \`${MODEL}\``);
  lines.push(`- **Target API**: \`${GOPEDIA_BASE}\``);
  lines.push(`- **Started**: \`${startedAt}\``);
  lines.push(`- **Finished**: \`${finishedAt}\``);
  lines.push("");

  for (const diff of ["simple", "intermediate", "advanced"] as const) {
    const group = results.filter((r) => r.difficulty === diff);
    if (!group.length) continue;
    lines.push(`## ${diff.charAt(0).toUpperCase() + diff.slice(1)}`);
    lines.push("");

    for (const r of group) {
      const badge = r.pass ? "✅ PASS" : r.error ? "❌ ERROR" : "❌ FAIL";
      lines.push(`### ${r.id} — ${r.note}`);
      lines.push(`- **Status**: ${badge}  (${r.durationMs}ms)`);
      lines.push(`- **Question**: _"${r.question}"_`);
      lines.push(`- **Tool calls**: ${r.toolCalls.map((c) => `\`${c.name}\``).join(" → ") || "none"}`);
      lines.push(`- **Expected**: \`${scenario(r.id)?.expectedKeywords.join("`, `")}\``);
      if (r.hitKeywords.length) lines.push(`- **Hit**: \`${r.hitKeywords.join("`, `")}\``);
      if (r.missedKeywords.length) lines.push(`- **Missed**: \`${r.missedKeywords.join("`, `")}\``);
      if (r.error) lines.push(`- **Error**: ${r.error}`);
      lines.push("");
      if (r.answer) {
        lines.push(`<details><summary>Agent answer</summary>\n\n${r.answer}\n\n</details>`);
        lines.push("");
      }
    }
  }

  const pass = results.filter((r) => r.pass).length;
  lines.push("## Summary");
  lines.push("");
  lines.push("| Total | Pass | Fail |");
  lines.push("|-------|------|------|");
  lines.push(`| ${results.length} | ${pass} | ${results.length - pass} |`);
  lines.push("");

  // Tool usage stats
  const allCalls = results.flatMap((r) => r.toolCalls);
  const toolCounts: Record<string, number> = {};
  for (const c of allCalls) toolCounts[c.name] = (toolCounts[c.name] ?? 0) + 1;
  lines.push("## Tool usage");
  lines.push("");
  for (const [name, count] of Object.entries(toolCounts)) {
    lines.push(`- \`${name}\`: ${count} calls`);
  }
  lines.push("");

  return lines.join("\n");
}

function scenario(id: string) {
  return SCENARIOS.find((s) => s.id === id);
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is required");
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });
  const startedAt = new Date().toISOString();

  console.log(`Model  : ${MODEL}`);
  console.log(`API    : ${GOPEDIA_BASE}`);
  console.log(`Scenarios: ${SCENARIOS.length}`);
  console.log("");

  const results: ScenarioResult[] = [];
  for (const scenario of SCENARIOS) {
    process.stdout.write(`[${scenario.id}] ${scenario.note} ... `);
    const result = await runScenario(client, scenario);
    results.push(result);
    const badge = result.pass ? "✅" : "❌";
    const tools = result.toolCalls.map((c) => c.name).join("→");
    console.log(`${badge} ${result.durationMs}ms  [${tools}]`);
    if (!result.pass && result.missedKeywords.length) {
      console.log(`   missed: ${result.missedKeywords.join(", ")}`);
    }
  }

  const finishedAt = new Date().toISOString();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  await mkdir(join(process.cwd(), "data", "logs"), { recursive: true });

  const jsonPath = join(process.cwd(), "data", "logs", `agent-e2e-test-${stamp}.json`);
  const mdPath = join(process.cwd(), "data", "logs", "agent-e2e-test-latest.md");

  const report = { model: MODEL, startedAt, finishedAt, gopediaBase: GOPEDIA_BASE, results };
  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  await writeFile(mdPath, buildMarkdown(results, startedAt, finishedAt));

  const pass = results.filter((r) => r.pass).length;
  console.log(`\nResult : ${pass}/${results.length} passed`);
  console.log(`JSON   : ${jsonPath}`);
  console.log(`MD     : ${mdPath}`);

  if (pass < results.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
