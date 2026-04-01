#!/usr/bin/env node
/**
 * Gopedia MCP Server
 *
 * Exposes Gopedia's HTTP API as MCP tools so AI agents (Claude Code, etc.)
 * can search, ingest, and inspect the knowledge graph directly.
 *
 * Tools:
 *   gopedia_health  — GET /api/health/deps
 *   gopedia_search  — GET /api/search?q=...&format=json  (default: detail=summary)
 *   gopedia_restore — GET /api/restore?l2_id=...  or  ?l1_id=...
 *   gopedia_ingest  — POST /api/ingest
 *
 * Environment:
 *   GOPEDIA_API_URL      Full base URL of the Gopedia HTTP API (highest priority)
 *   GOPEDIA_HOST_DOMAIN  Host[:port] or full URL for Gopedia API (default: 127.0.0.1:18787)
 */

/// <reference types="node" />

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const apiUrlFromEnv = process.env["GOPEDIA_API_URL"]?.trim();
const hostDomainFromEnv = process.env["GOPEDIA_HOST_DOMAIN"]?.trim() ?? "127.0.0.1:18787";
const normalizedHostDomain = /^https?:\/\//.test(hostDomainFromEnv)
  ? hostDomainFromEnv
  : `http://${hostDomainFromEnv}`;
const BASE_URL = (apiUrlFromEnv ?? normalizedHostDomain).replace(/\/$/, "");

// ── types ─────────────────────────────────────────────────────────────────────

interface Envelope {
  ok: boolean;
  request_id?: string | null;
  data?: unknown;
  failure?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    details?: unknown;
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalise any API response into the common envelope shape:
 *   { ok, request_id?, data?, failure? }
 *
 * The Gopedia API already emits ok/failure on subprocess errors (HTTP 200).
 * For network-level failures we synthesise the same shape so agents always see
 * a consistent structure and can act on failure.retryable.
 */
function toEnvelope(raw: unknown, httpOk: boolean): Envelope {
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if ("ok" in r || "failure" in r) {
      return {
        ok: typeof r["ok"] === "boolean" ? r["ok"] : httpOk,
        request_id: (r["request_id"] as string | undefined) ?? null,
        data: r["data"] ?? (r["ok"] !== false ? r : undefined),
        ...(r["failure"] ? { failure: r["failure"] as Envelope["failure"] } : {}),
      };
    }
  }
  if (!httpOk) {
    return {
      ok: false,
      failure: {
        code: "HTTP_ERROR",
        message: "Upstream returned a non-2xx status",
        retryable: false,
        details: raw,
      },
    };
  }
  return { ok: true, data: raw };
}

async function get(path: string): Promise<string> {
  try {
    const res = await fetch(`${BASE_URL}${path}`);
    const text = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text, status: res.status }; }
    return JSON.stringify(toEnvelope(parsed, res.ok), null, 2);
  } catch (err) {
    return JSON.stringify({ ok: false, failure: { code: "NETWORK_ERROR", message: String(err), retryable: true } } satisfies Envelope, null, 2);
  }
}

async function post(path: string, body: unknown): Promise<string> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text, status: res.status }; }
    return JSON.stringify(toEnvelope(parsed, res.ok), null, 2);
  } catch (err) {
    return JSON.stringify({ ok: false, failure: { code: "NETWORK_ERROR", message: String(err), retryable: true } } satisfies Envelope, null, 2);
  }
}

// ── server ────────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "gopedia",
  version: "2.0.0",
});

// ── tool: health ──────────────────────────────────────────────────────────────

server.registerTool(
  "gopedia_health",
  {
    description: "Check Gopedia service health and dependency status (Postgres, Qdrant, TypeDB, Phloem).",
  },
  async () => {
    const text = await get("/api/health/deps");
    return { content: [{ type: "text", text }] };
  }
);

// ── tool: search ──────────────────────────────────────────────────────────────

server.registerTool(
  "gopedia_search",
  {
    description: `Search the Gopedia knowledge graph using semantic search (Xylem pipeline).

## Escalation order — always start cheap, escalate only when needed
  1. detail=summary  (default) — title, snippet, source_path, l3_id, score
                                  Start here. Stop if snippet is sufficient to answer.
  2. detail=standard           — summary + project_id, l1_id, l2_id, section_heading, breadcrumb
                                  Use when you need l2_id/l1_id pointers for gopedia_restore.
  3. detail=full               — all fields including surrounding_context
                                  Use only when surrounding context is required.
  4. gopedia_restore(l2_id)    — full section body (call after obtaining l2_id above)
  5. gopedia_restore(l1_id)    — full document body (use sparingly)

## Comparison queries ("A vs B")
  Run independent searches per concept, collect l2_id pointers,
  call gopedia_restore on top hits, then synthesise.

## Response envelope
  { ok, request_id?, data: { results[] }, failure? }
  Check failure.retryable before retrying on error.

detail presets (controls which fields are returned):
  summary  — doc_id, doc_name, l3_id, score, title, snippet, source_path (cheapest, default)
  standard — summary + project_id, l1_id, l2_id, section_heading, breadcrumb
  full     — all fields including surrounding_context

fields — comma-separated list of exact field names; overrides detail when provided.
         Valid keys: doc_id, doc_name, project_id, l1_id, l2_id, l3_id, score, title,
         section_heading, snippet, source_path, breadcrumb, surrounding_context`,
    inputSchema: {
      query: z.string().describe("Search query text"),
      detail: z
        .enum(["summary", "standard", "full"])
        .optional()
        .describe("Field preset — summary (default) | standard | full"),
      fields: z
        .string()
        .optional()
        .describe("Comma-separated field names (overrides detail)"),
      project_id: z
        .number()
        .int()
        .optional()
        .describe("Filter results to a specific project integer ID"),
    },
  },
  async ({ query, detail, fields, project_id }) => {
    const params = new URLSearchParams({ q: query, format: "json" });
    // Default to summary for token efficiency; agent escalates explicitly if needed
    params.set("detail", detail ?? "summary");
    if (fields) params.set("fields", fields);
    if (project_id !== undefined) params.set("project_id", String(project_id));

    const text = await get(`/api/search?${params.toString()}`);
    return { content: [{ type: "text", text }] };
  }
);

// ── tool: restore ─────────────────────────────────────────────────────────────

server.registerTool(
  "gopedia_restore",
  {
    description: `Restore full stored content from PostgreSQL by section (l2_id) or document (l1_id).

## When to call
  - Call ONLY after gopedia_search returns l2_id or l1_id pointers (detail=standard or full).
  - Do NOT call without a prior search — always search first.
  - Prefer l2_id (section-level) to minimise response size.
  - Use l1_id only for whole-document reconstruction or when multiple sections are needed.

## Mutual exclusivity
  Provide exactly ONE of l2_id or l1_id. Providing both or neither is an error.

## Response envelope
  { ok, request_id?, data: { content, source_path, section_heading, ... }, failure? }`,
    inputSchema: {
      l2_id: z
        .string()
        .optional()
        .describe("Section-level UUID from a prior search result (preferred, smaller response)"),
      l1_id: z
        .string()
        .optional()
        .describe("Document-level UUID from a prior search result (full document, use sparingly)"),
      format: z
        .enum(["json", "markdown"])
        .optional()
        .describe("Response format — json (default) | markdown"),
    },
  },
  async ({ l2_id, l1_id, format }) => {
    if (!l2_id && !l1_id) {
      const envelope: Envelope = {
        ok: false,
        failure: { code: "INVALID_INPUT", message: "Exactly one of l2_id or l1_id must be provided.", retryable: false },
      };
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    }
    if (l2_id && l1_id) {
      const envelope: Envelope = {
        ok: false,
        failure: { code: "INVALID_INPUT", message: "Provide either l2_id or l1_id — not both.", retryable: false },
      };
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    }

    const params = new URLSearchParams();
    if (l2_id) params.set("l2_id", l2_id);
    if (l1_id) params.set("l1_id", l1_id);
    params.set("format", format ?? "json");

    const text = await get(`/api/restore?${params.toString()}`);
    return { content: [{ type: "text", text }] };
  }
);

// ── tool: ingest ──────────────────────────────────────────────────────────────

server.registerTool(
  "gopedia_ingest",
  {
    description: `Ingest a markdown file or directory into the Gopedia knowledge graph (synchronous, 30-minute timeout).

path must be an absolute path or a repo-relative path that the Gopedia API process can access.`,
    inputSchema: {
      path: z.string().describe("Absolute or repo-relative path to ingest"),
      project_id: z
        .number()
        .int()
        .optional()
        .describe("Associate the ingest with a project integer ID"),
    },
  },
  async ({ path, project_id }) => {
    const body: Record<string, unknown> = { path };
    if (project_id !== undefined) body.project_id = project_id;

    const text = await post("/api/ingest", body);
    return { content: [{ type: "text", text }] };
  }
);

// ── prompt: agent guide ───────────────────────────────────────────────────────

server.registerPrompt(
  "gopedia_agent_guide",
  {
    description:
      "System prompt that teaches an AI agent how to explore Gopedia step-by-step using the MCP tools. " +
      "Inject this after a successful gopedia_health check to enable structured, token-efficient knowledge retrieval.",
  },
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `You are an AI assistant with access to the Gopedia knowledge graph via MCP tools.
Always follow the escalation ladder below — stop as soon as you have enough context to answer.

## Tool overview
- gopedia_health       — Verify the service is reachable before any search or restore.
- gopedia_search       — Semantic search. Returns ranked hits with l2_id/l1_id pointers.
- gopedia_restore      — Fetch full section (l2_id) or document (l1_id) body from PostgreSQL.
- gopedia_ingest       — Ingest markdown files into the knowledge graph (not for Q&A flows).

## Escalation ladder (cheapest → most expensive)
1. gopedia_search(detail=summary)
   → Returns title, snippet, source_path, score.
   → STOP here if the snippet gives enough context to answer accurately.

2. gopedia_search(detail=standard)
   → Adds l2_id, l1_id, section_heading, breadcrumb.
   → Use when you need pointers for gopedia_restore, or to identify the right section.

3. gopedia_search(detail=full)
   → Adds surrounding_context.
   → Use only when you need nearby lines without fetching the entire section.

4. gopedia_restore(l2_id)
   → Full section body from PostgreSQL.
   → Use when snippet + surrounding_context is still insufficient.
   → Prefer this over l1_id — smaller response, faster.

5. gopedia_restore(l1_id)
   → Full document body.
   → Use only for whole-document reconstruction or when multiple sections are needed.

## Rules
- Always call gopedia_health first and abort if ok=false.
- Never call gopedia_restore without a prior search that returned the id.
- Prefer l2_id over l1_id to keep response size small.
- Check failure.retryable before retrying a failed call.

## Comparison queries  ("How does A differ from B?")
1. Run gopedia_search(detail=summary) independently for each concept (can be parallel).
2. Identify the most relevant l2_id for each concept.
3. Call gopedia_restore(l2_id) for each.
4. Synthesise both results into a grounded, cited answer.

## Multi-step abstract queries  ("Summarise X", "What components handle Y?")
1. Break the question into 2–3 focused search queries.
2. Run gopedia_search(detail=summary) for each.
3. Collect the top l2_id pointers across results.
4. Call gopedia_restore(l2_id) only for hits where the snippet is insufficient.
5. Combine retrieved content into a structured answer.

## Citations
Every answer must include citations in the form:
  [source_path § section_heading] (l2_id: <uuid>)
Never answer from memory alone — always ground claims in retrieved content.`,
        },
      },
    ],
  })
);

// ── start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
