/**
 * claude-code-search-test.ts
 *
 * gopedia MCP 서버를 MCP 클라이언트로 직접 호출하여
 * gopedia / neunexus 콘텐츠 기반 검색 시나리오를 단순→고난도 순으로 테스트합니다.
 *
 * 각 시나리오는 문서에 명백히 존재하는 answer를 가지며,
 * 결과에서 expectedAnswer 가 발견되지 않으면 FAIL 처리합니다.
 *
 * 로그 파일:
 *   data/logs/claude_code-search-test-<timestamp>.json
 *   data/logs/claude_code-search-test-latest.md
 */

import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ── types ─────────────────────────────────────────────────────────────────────

type Difficulty = "simple" | "intermediate" | "advanced";
type DetailPreset = "summary" | "standard" | "full";

type SearchScenario = {
  id: string;
  difficulty: Difficulty;
  query: string;
  detail: DetailPreset;
  note: string;
  /** 문서에서 찾을 수 있는 명확한 정답 (모두 존재해야 PASS) */
  expectedAnswer: string[];
  /** 정답 출처 (사람이 확인용) */
  source: string;
};

type ToolResult = {
  name: string;
  ok: boolean;
  durationMs: number;
  payload: unknown;
  /** expectedAnswer 중 실제 hit된 것들 */
  hitAnswers?: string[];
  /** expectedAnswer 중 결과에 없는 것들 */
  missedAnswers?: string[];
  error?: string;
};

// ── scenarios ─────────────────────────────────────────────────────────────────
// 각 시나리오는 문서에 문자 그대로 존재하는 명확한 정답을 가집니다.

const SCENARIOS: SearchScenario[] = [
  // ── Simple ──────────────────────────────────────────────────────────────────
  {
    id: "S1",
    difficulty: "simple",
    query: "gopedia를 핵심 키워드 하나로 표현하면 무엇인가?",
    detail: "summary",
    note: "gopedia 핵심 키워드",
    expectedAnswer: ["지식 신경망"],
    source: "gopedia/README.md — '파편화된 정보를 하나의 유기적인 지식 신경망으로 통합하는'",
  },
  {
    id: "S2",
    difficulty: "simple",
    query: "neunexus에서 실시간 메시징과 사용자 알림을 담당하는 서비스 이름은?",
    detail: "summary",
    note: "neunexus 실시간 메시징 서비스",
    expectedAnswer: ["Tinode"],
    source: "neunexus/README.md — 'Tinode | 실시간 메시징, 사용자 알림, 에이전트 간 인터랙션 채널'",
  },
  {
    id: "S3",
    difficulty: "simple",
    query: "gopedia 모듈 이름에 -so 접미사를 붙이는 이유는 무엇인가?",
    detail: "summary",
    note: "gopedia -so 접미사의 의미",
    expectedAnswer: ["공간감"],
    source:
      "gopedia/README.md — '특정 기능을 전담하여 관리하는 \"관리소\" 성격의 모듈에는 -so 접미사를 붙여 공간감을 부여합니다'",
  },

  // ── Intermediate ─────────────────────────────────────────────────────────────
  {
    id: "S4",
    difficulty: "intermediate",
    query:
      "gopedia에서 Leaf 데이터를 흡수하여 Rhizome 저장소로 끌어올리는 인게스션 흐름의 이름은?",
    detail: "standard",
    note: "Xylem flow 명칭",
    expectedAnswer: ["xylem-flow", "목질부"],
    source: "gopedia/README.md — 'xylem-flow (목질부): Leaf(데이터)를 흡수하여 Rhizome(저장소)으로 끌어올리는 인게스션 흐름'",
  },
  {
    id: "S5",
    difficulty: "intermediate",
    query:
      "neunexus에서 Traefik이 사용하는 네트워크 3가지는 무엇인가? (Macvlan, 컨테이너 내부 통신, 포트 포워딩)",
    detail: "standard",
    note: "Traefik 네트워크 3종",
    expectedAnswer: ["neunexus", "traefik-net", "traefik_ports"],
    source:
      "neunexus/skills/traefik/references/overview.md — neunexus(Macvlan), traefik-net(External), traefik_ports(Bridge)",
  },
  {
    id: "S6",
    difficulty: "intermediate",
    query:
      "gopedia가 RAG 토큰 비용 절감을 위해 문서를 구조화하는 계층 이름을 모두 나열하면?",
    detail: "standard",
    note: "L1/L2/L3 계층 구조",
    expectedAnswer: ["L1", "L2", "L3"],
    source:
      "gopedia/reference/gopedia-feature-guide.md — 'L1 (Global Summary) / L2 (ToC / Sectional Summary) / L3 (Atomic Chunk)'",
  },

  // ── Advanced ─────────────────────────────────────────────────────────────────
  {
    id: "S7",
    difficulty: "advanced",
    query:
      "gopedia auth-so가 채택한 권한 관리 시스템 이름과 권한 모델 방식은 무엇인가?",
    detail: "full",
    note: "auth-so: SpiceDB + ReBAC",
    expectedAnswer: ["SpiceDB", "ReBAC"],
    source:
      "gopedia/README.md — 'auth-so: SpiceDB 기반의 관계 중심 권한(ReBAC) 관리 모듈' / gopedia/reference/gopedia-feature-guide.md §12",
  },
  {
    id: "S8",
    difficulty: "advanced",
    query:
      "neunexus에서 Traefik이 Macvlan 네트워크에 할당받은 고정 IP 주소는 얼마인가?",
    detail: "full",
    note: "Traefik Macvlan 고정 IP",
    expectedAnswer: ["192.168.0.3"],
    source:
      "neunexus/skills/traefik/references/overview.md — 'Traefik static IP: 192.168.0.3'",
  },
  {
    id: "S9",
    difficulty: "advanced",
    query:
      "gopedia Smart Sink에서 L3 데이터가 저장되는 두 개의 저장소는 무엇이며 각각의 역할은?",
    detail: "full",
    note: "L3 → Qdrant(청크 임베딩) + ClickHouse(원문·감사)",
    expectedAnswer: ["Qdrant", "ClickHouse"],
    source:
      "gopedia/reference/gopedia-feature-guide.md §7 — 'L3 → Qdrant(청크 임베딩) + ClickHouse(원문·감사)'",
  },
];

// ── helpers ───────────────────────────────────────────────────────────────────

function extractText(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const r = result as Record<string, unknown>;
  if (Array.isArray(r["content"])) {
    for (const item of r["content"] as Array<{ type?: string; text?: string }>) {
      if (item?.type === "text" && typeof item?.text === "string") return item.text;
    }
  }
  return JSON.stringify(result);
}

function parsePayload(result: unknown): unknown {
  const text = extractText(result);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * expectedAnswer 배열을 확인하여 hit / miss 분류
 * Case-insensitive 매칭
 */
function checkAnswers(
  payload: unknown,
  expected: string[]
): { hits: string[]; misses: string[] } {
  const text = JSON.stringify(payload).toLowerCase();
  const hits: string[] = [];
  const misses: string[] = [];
  for (const ans of expected) {
    if (text.includes(ans.toLowerCase())) hits.push(ans);
    else misses.push(ans);
  }
  return { hits, misses };
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ── status badge ──────────────────────────────────────────────────────────────

function statusBadge(r: ToolResult, scenario?: SearchScenario): string {
  if (!r.ok) return "❌ FAIL (error)";
  if (!scenario) return "✅ PASS";
  if ((r.missedAnswers?.length ?? 0) > 0) return "❌ FAIL (expected content not found)";
  return "✅ PASS";
}

// ── markdown report ───────────────────────────────────────────────────────────

function buildMarkdown(
  report: ReturnType<typeof buildReport>,
  jsonFile: string
): string {
  const lines: string[] = [];
  lines.push("# Claude Code — Gopedia MCP Search Test Report");
  lines.push("");
  lines.push(`- **Target API**: \`${report.targetApiBase}\``);
  lines.push(`- **Started**: \`${report.startedAt}\``);
  lines.push(`- **Finished**: \`${report.finishedAt}\``);
  lines.push(`- **Result**: \`${report.success ? "success" : "FAILED"}\``);
  lines.push(`- **Raw log**: \`${jsonFile}\``);
  lines.push("");

  // infra
  lines.push("## Infra Checks");
  lines.push("");
  for (const r of report.results.filter((r) =>
    ["tools/list", "gopedia_health"].includes(r.name)
  )) {
    lines.push(`- \`${r.name}\` — ${r.ok ? "✅ PASS" : "❌ FAIL"} (${r.durationMs}ms)`);
    if (!r.ok && r.error) lines.push(`  - Error: ${r.error}`);
  }
  lines.push("");

  // per-difficulty group
  const groups: Record<Difficulty, ToolResult[]> = {
    simple: [],
    intermediate: [],
    advanced: [],
  };
  for (const r of report.results) {
    const sc = SCENARIOS.find((s) => r.name === `gopedia_search_${s.id}`);
    if (sc) groups[sc.difficulty].push(r);
  }

  for (const diff of ["simple", "intermediate", "advanced"] as Difficulty[]) {
    const items = groups[diff];
    if (!items.length) continue;
    lines.push(
      `## ${diff.charAt(0).toUpperCase() + diff.slice(1)} Scenarios`
    );
    lines.push("");
    for (const r of items) {
      const sc = SCENARIOS.find((s) => r.name === `gopedia_search_${s.id}`)!;
      lines.push(`### ${sc.id} — ${sc.note}`);
      lines.push(`- **Query**: _"${sc.query}"_`);
      lines.push(`- **Detail preset**: \`${sc.detail}\``);
      lines.push(`- **Status**: ${statusBadge(r, sc)}`);
      lines.push(`- **Duration**: ${r.durationMs}ms`);
      lines.push(`- **Expected answers**: \`${sc.expectedAnswer.join("`, `")}\``);
      if (r.hitAnswers?.length)
        lines.push(`- **Hit**: \`${r.hitAnswers.join("`, `")}\``);
      if (r.missedAnswers?.length)
        lines.push(`- **Missed**: \`${r.missedAnswers.join("`, `")}\` ← not found in results`);
      lines.push(`- **Source**: ${sc.source}`);
      if (!r.ok && r.error) lines.push(`- **Error**: ${r.error}`);
      else {
        const p = r.payload as { response?: { results?: unknown[] } };
        const cnt = Array.isArray(p?.response?.results)
          ? p.response.results.length
          : null;
        if (cnt !== null) lines.push(`- **Results returned**: ${cnt}`);
      }
      lines.push("");
    }
  }

  // summary table
  const scenarioResults = report.results.filter((r) =>
    r.name.startsWith("gopedia_search_S")
  );
  const passCount = scenarioResults.filter(
    (r) => r.ok && (r.missedAnswers?.length ?? 0) === 0
  ).length;
  const failCount = scenarioResults.length - passCount;

  lines.push("## Summary");
  lines.push("");
  lines.push("| Total | Pass | Fail |");
  lines.push("|-------|------|------|");
  lines.push(`| ${scenarioResults.length} | ${passCount} | ${failCount} |`);
  lines.push("");

  return lines.join("\n");
}

function buildReport(
  startedAt: string,
  finishedAt: string,
  apiBase: string,
  results: ToolResult[],
  connectError?: string
) {
  const scenarioResults = results.filter((r) =>
    r.name.startsWith("gopedia_search_S")
  );
  const allPass =
    !connectError &&
    scenarioResults.every((r) => r.ok && (r.missedAnswers?.length ?? 0) === 0);

  return {
    tool: "claude_code",
    startedAt,
    finishedAt,
    targetApiBase: apiBase,
    success: allPass,
    connectError,
    results,
  };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = new Date().toISOString();
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
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      ),
      GOPEDIA_API_URL: apiBase,
    },
    stderr: "pipe",
  });

  const client = new Client({ name: "claude-code-search-test", version: "1.0.0" });
  const results: ToolResult[] = [];
  let connectError: string | undefined;

  try {
    await client.connect(transport);

    // tools/list
    let t = Date.now();
    const listed = await client.listTools();
    results.push({
      name: "tools/list",
      ok: true,
      durationMs: Date.now() - t,
      payload: listed.tools.map((tool) => tool.name),
    });

    // health
    t = Date.now();
    const health = await client.callTool({ name: "gopedia_health", arguments: {} });
    results.push({
      name: "gopedia_health",
      ok: true,
      durationMs: Date.now() - t,
      payload: parsePayload(health),
    });

    // search scenarios
    for (const scenario of SCENARIOS) {
      t = Date.now();
      try {
        const raw = await client.callTool({
          name: "gopedia_search",
          arguments: { query: scenario.query, detail: scenario.detail },
        });
        const response = parsePayload(raw);
        const { hits, misses } = checkAnswers(response, scenario.expectedAnswer);

        results.push({
          name: `gopedia_search_${scenario.id}`,
          ok: true,
          durationMs: Date.now() - t,
          payload: { scenario, response },
          hitAnswers: hits,
          missedAnswers: misses,
        });
      } catch (error) {
        results.push({
          name: `gopedia_search_${scenario.id}`,
          ok: false,
          durationMs: Date.now() - t,
          payload: { scenario },
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    connectError = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
  }

  const finishedAt = new Date().toISOString();
  const report = buildReport(startedAt, finishedAt, apiBase, results, connectError);

  await mkdir(join(process.cwd(), "data", "logs"), { recursive: true });

  const stamp = nowStamp();
  const jsonFile = `claude_code-search-test-${stamp}.json`;
  const jsonPath = join(process.cwd(), "data", "logs", jsonFile);
  const mdPath = join(
    process.cwd(),
    "data",
    "logs",
    "claude_code-search-test-latest.md"
  );

  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  await writeFile(mdPath, buildMarkdown(report, jsonFile), "utf-8");

  if (!report.success) {
    const failed = results.filter(
      (r) => !r.ok || (r.missedAnswers?.length ?? 0) > 0
    );
    console.error(
      JSON.stringify({ success: false, connectError, failed }, null, 2)
    );
    process.exit(1);
  }

  console.log(`JSON : ${jsonPath}`);
  console.log(`MD   : ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
