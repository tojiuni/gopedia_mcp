import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type ToolResult = {
  name: string;
  ok: boolean;
  payload: unknown;
  error?: string;
};

type SearchScenario = {
  id: string;
  difficulty: "simple" | "intermediate" | "advanced";
  query: string;
  detail: "summary" | "standard" | "full";
  note: string;
};

const SEARCH_SCENARIOS: SearchScenario[] = [
  {
    id: "S1",
    difficulty: "simple",
    query: "gopedia 프로젝트의 소개 또는 목적을 설명하는 문서 내용을 찾아줘",
    detail: "summary",
    note: "기초 질의: gopedia 관련 기본 설명 탐색",
  },
  {
    id: "S2",
    difficulty: "simple",
    query: "neunexus 프로젝트의 핵심 키워드와 개요를 보여줘",
    detail: "summary",
    note: "기초 질의: neunexus 개요 탐색",
  },
  {
    id: "S3",
    difficulty: "intermediate",
    query: "universitas 맥락에서 gopedia와 neunexus 각각의 주요 컴포넌트를 정리해줘",
    detail: "standard",
    note: "중간 질의: 두 프로젝트 맥락 동시 탐색",
  },
  {
    id: "S4",
    difficulty: "intermediate",
    query: "gopedia에서 데이터 처리 또는 파이프라인 흐름을 설명한 섹션을 찾아줘",
    detail: "standard",
    note: "중간 질의: 구조/흐름 관련 검색",
  },
  {
    id: "S5",
    difficulty: "advanced",
    query:
      "neunexus와 gopedia의 설계 관점 차이(모듈 경계, 책임 분리, 운영 관점)를 비교할 수 있는 근거 문맥을 찾아줘",
    detail: "full",
    note: "고난도 질의: 비교/추론을 위한 근거 문맥 수집",
  },
  {
    id: "S6",
    difficulty: "advanced",
    query:
      "universitas 저장소 내 gopedia + neunexus 문서에서 아키텍처 의사결정이나 트레이드오프를 보여주는 surrounding_context를 찾아줘",
    detail: "full",
    note: "고난도 질의: 주변 문맥 포함 근거 탐색",
  },
];

function getTextPayload(result: unknown): unknown {
  if (!result || typeof result !== "object" || !("content" in result)) return result;
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content)) return result;
  const firstText = content.find((item) => item?.type === "text" && typeof item?.text === "string");
  if (!firstText?.text) return result;
  try {
    return JSON.parse(firstText.text);
  } catch {
    return firstText.text;
  }
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

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
        Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
      ),
      GOPEDIA_API_URL: apiBase,
    },
    stderr: "pipe",
  });

  const client = new Client({
    name: "gopedia-mcp-smoke-test",
    version: "1.0.0",
  });

  const results: ToolResult[] = [];
  let connectError: string | undefined;

  try {
    await client.connect(transport);

    const listedTools = await client.listTools();
    results.push({
      name: "tools/list",
      ok: true,
      payload: listedTools.tools.map((tool) => tool.name),
    });

    const health = await client.callTool({ name: "gopedia_health", arguments: {} });
    results.push({
      name: "gopedia_health",
      ok: true,
      payload: getTextPayload(health),
    });

    const search = await client.callTool({
      name: "gopedia_search",
      arguments: { query: "Introduction", detail: "summary" },
    });
    results.push({
      name: "gopedia_search",
      ok: true,
      payload: getTextPayload(search),
    });

    for (const scenario of SEARCH_SCENARIOS) {
      try {
        const scenarioResult = await client.callTool({
          name: "gopedia_search",
          arguments: { query: scenario.query, detail: scenario.detail },
        });
        results.push({
          name: `gopedia_search_${scenario.id}`,
          ok: true,
          payload: {
            scenario,
            response: getTextPayload(scenarioResult),
          },
        });
      } catch (error) {
        results.push({
          name: `gopedia_search_${scenario.id}`,
          ok: false,
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
      // ignore close errors in logs-only script
    }
  }

  const finishedAt = new Date().toISOString();
  const success = !connectError && results.every((r) => r.ok);

  const report = {
    startedAt,
    finishedAt,
    success,
    targetApiBase: apiBase,
    connectError,
    results,
  };

  await mkdir(join(process.cwd(), "data", "logs"), { recursive: true });
  const filePath = join(process.cwd(), "data", "logs", `mcp-smoke-test-${nowStamp()}.json`);
  await writeFile(filePath, JSON.stringify(report, null, 2), "utf-8");

  if (!success) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  console.log(filePath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
