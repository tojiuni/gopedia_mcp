#!/usr/bin/env node
/**
 * Gopedia MCP Server
 *
 * Exposes Gopedia's HTTP API as MCP tools so AI agents (Claude Code, etc.)
 * can search, ingest, and inspect the knowledge graph directly.
 *
 * Tools:
 *   gopedia_health                — GET /api/health/deps
 *   gopedia_search                — GET /api/search?q=...&format=json  (default: detail=summary)
 *   gopedia_restore               — GET /api/restore?l2_id=...  or  ?l1_id=...
 *   gopedia_ingest                — POST /api/ingest
 *   gopedia_delete                — DELETE /api/documents
 *   gardener_health               — GET Gardener /health
 *   gardener_quality_run          — Dataset → resolve-qrels → eval run → wait → metrics + report
 *   gardener_run_report           — Aggregate metrics, KPI summary, /details failures for a run id
 *   memory_save                   — POST /api/memory/save
 *   memory_index                  — GET  /api/memory/index
 *   memory_recall                 — POST /api/memory/recall
 *   memory_get                    — GET  /api/memory/get?id=...
 *   memory_forget                 — POST /api/memory/forget
 *   memory_scratch_list           — GET  /api/memory/scratch
 *   memory_import_claude_code     — POST /api/memory/import/claude-code
 *   memory_capabilities           — GET  /api/memory/capabilities
 *   memory_proposals              — GET  /api/memory/proposals
 *   memory_proposal_accept        — POST /api/memory/proposal/accept
 *   memory_proposal_skip          — POST /api/memory/proposal/skip
 *   memory_proposal_reject        — POST /api/memory/proposal/reject
 *
 * Environment:
 *   GOPEDIA_API_URL       Full base URL of the Gopedia HTTP API (highest priority)
 *   GOPEDIA_HOST_DOMAIN   Host[:port] or full URL for Gopedia API (default: 127.0.0.1:18787)
 *                         neunexus: 18787 = cluster prod (use for cluster work/ingest),
 *                         18799 = local test (Colima, no geneso clone -> ingest "Path not found").
 *   GARDENER_API_URL      Full base URL of Gardener (default from GARDENER_HOST_DOMAIN)
 *   GARDENER_HOST_DOMAIN  Host[:port] or full URL (default: 127.0.0.1:18880)
 */

/// <reference types="node" />

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { z } from "zod";

const apiUrlFromEnv = process.env["GOPEDIA_API_URL"]?.trim();
const hostDomainFromEnv = process.env["GOPEDIA_HOST_DOMAIN"]?.trim() ?? "127.0.0.1:18787";
const normalizedHostDomain = /^https?:\/\//.test(hostDomainFromEnv)
  ? hostDomainFromEnv
  : `http://${hostDomainFromEnv}`;
const BASE_URL = (apiUrlFromEnv ?? normalizedHostDomain).replace(/\/$/, "");

const API_TOKEN = process.env["GOPEDIA_API_TOKEN"]?.trim() ?? "";

const gardenerApiUrlFromEnv = process.env["GARDENER_API_URL"]?.trim();
const gardenerHostFromEnv = process.env["GARDENER_HOST_DOMAIN"]?.trim() ?? "127.0.0.1:18880";
const normalizedGardenerHost = /^https?:\/\//.test(gardenerHostFromEnv)
  ? gardenerHostFromEnv
  : `http://${gardenerHostFromEnv}`;
const GARDENER_BASE_URL = (gardenerApiUrlFromEnv ?? normalizedGardenerHost).replace(/\/$/, "");

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

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return API_TOKEN
    ? { Authorization: `Bearer ${API_TOKEN}`, ...extra }
    : { ...extra };
}

async function get(path: string): Promise<string> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders() });
    const text = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text, status: res.status }; }
    return JSON.stringify(toEnvelope(parsed, res.ok), null, 2);
  } catch (err) {
    return JSON.stringify({ ok: false, failure: { code: "NETWORK_ERROR", message: String(err), retryable: true } } satisfies Envelope, null, 2);
  }
}

async function del(path: string, body: unknown): Promise<string> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "DELETE",
      headers: authHeaders({ "Content-Type": "application/json" }),
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

async function post(path: string, body: unknown): Promise<string> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
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

/** Plain JSON from Gardener (FastAPI); not wrapped in Gopedia's ok/failure envelope. */
async function gardenerFetch(
  path: string,
  init?: RequestInit & { timeoutMs?: number }
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const timeoutMs = init?.timeoutMs ?? 60_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = new Headers(init?.headers);
    if (init?.body != null && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetch(`${GARDENER_BASE_URL}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers,
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { raw: text };
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: { error: String(err), gardener_base_url: GARDENER_BASE_URL },
    };
  } finally {
    clearTimeout(timer);
  }
}

function aggregateMetricsFromList(metrics: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(metrics)) return out;
  for (const m of metrics) {
    if (!m || typeof m !== "object") continue;
    const row = m as Record<string, unknown>;
    if (row["scope"] !== "aggregate") continue;
    const name = row["metric_name"];
    const val = row["value"];
    if (typeof name === "string" && typeof val === "number") out[name] = val;
  }
  return out;
}

function metricFromQueryRow(row: Record<string, unknown>, name: string): number | undefined {
  const metrics = row["metrics"];
  if (!Array.isArray(metrics)) return undefined;
  for (const m of metrics) {
    if (m && typeof m === "object") {
      const o = m as Record<string, unknown>;
      if (o["metric_name"] === name && typeof o["value"] === "number") return o["value"];
    }
  }
  return undefined;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { _parse_error: true, _raw_excerpt: text.slice(0, 2000) };
  }
}

/** Matches Python: (recall_at_5 or 0) == 0 */
function recallAt5IsFailure(value: unknown): boolean {
  const n = value === null || value === undefined ? 0 : Number(value);
  return !Number.isFinite(n) || n === 0;
}

// ── server ────────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "gopedia",
  version: "2.1.0",
});

// ── tool: health ──────────────────────────────────────────────────────────────

server.registerTool(
  "gopedia_health",
  {
    description: "Check Gopedia service health, dependency status (Postgres, Qdrant, TypeDB, Phloem), and version information.",
  },
  async () => {
    const [healthResult, versionResult] = await Promise.allSettled([
      get("/api/health/deps"),
      get("/api/version"),
    ]);
    const health = healthResult.status === "fulfilled" ? safeJsonParse(healthResult.value) : { error: "health fetch failed" };
    const version = versionResult.status === "fulfilled" ? safeJsonParse(versionResult.value) : { error: "version fetch not available" };
    return {
      content: [{ type: "text", text: JSON.stringify({ ...(health as object), gopedia_version: version }, null, 2) }],
    };
  }
);

// ── tool: search ──────────────────────────────────────────────────────────────

server.registerTool(
  "gopedia_search",
  {
    description: `Search the Gopedia knowledge graph using semantic search (Xylem pipeline).

## Escalation order — always start cheap, escalate only when needed
  1. detail=summary  (default) — title, snippet, source_path, l3_id, score
                                  Use for most queries.
  2. detail=standard           — summary + project_id, l1_id, l2_id, section_heading, breadcrumb
                                  Use when section or document IDs are needed.
  3. detail=full               — all fields including surrounding_context
                                  Use only when surrounding context is required.
  4. gopedia_restore(l2_id)    — full section body (call after obtaining l2_id above)
  5. gopedia_restore(l1_id)    — full document body (use sparingly)

  Lateral preset (not an escalation step):
  - detail=meta — l3_id, score, title, source_path, tags
                  Use to check goquest ticket metadata (status, priority, domain, etc.)
                  without fetching snippet content.

## Comparison queries ("A vs B")
  Run independent searches per concept, collect l2_id pointers,
  call gopedia_restore on top hits, then synthesise.

## Response envelope
  { ok, request_id?, data: { results[] }, failure? }
  Check failure.retryable before retrying on error.

detail presets (controls which fields are returned):
  summary  — doc_id, doc_name, l3_id, score, title, snippet, source_path (cheapest, default)
  standard — summary + project_id, l1_id, l2_id, section_heading, breadcrumb
  meta     — l3_id, score, title, source_path, tags (ticket metadata: status, priority, domain, etc.)
  full     — all fields including surrounding_context

fields — comma-separated list of exact field names; overrides detail when provided.
         Valid keys: doc_id, doc_name, project_id, l1_id, l2_id, l3_id, score, title,
         section_heading, snippet, source_path, breadcrumb, surrounding_context, tags`,
    inputSchema: {
      query: z.string().describe("Search query text"),
      detail: z
        .enum(["summary", "standard", "meta", "full"])
        .optional()
        .describe("Field preset — summary (default) | standard | meta | full"),
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

source_path must be an absolute path or a repo-relative path that the Gopedia API process can access.`,
    inputSchema: {
      source_path: z.string().describe("Absolute or repo-relative path to ingest"),
      project_id: z
        .number()
        .int()
        .optional()
        .describe("Associate the ingest with a project integer ID"),
      force: z
        .boolean()
        .optional()
        .describe(
          "Force full re-ingest even if the project content hash is unchanged. " +
          "Use when files were added in the same git commit as a previous ingest " +
          "and were skipped due to hash deduplication. Default: false."
        ),
      ticket_id: z
        .string()
        .optional()
        .describe(
          "goquest sub-ticket ID that triggered this ingest. " +
          "When provided, TypeDB records a provenance link: document → ticket, " +
          "enabling 'who worked on this document and who requested it' queries."
        ),
    },
  },
  async ({ source_path, project_id, force, ticket_id }) => {
    const body: Record<string, unknown> = { path: source_path };
    if (project_id !== undefined) body.project_id = project_id;
    if (force) body.force = true;
    if (ticket_id !== undefined) body.ticket_id = ticket_id;

    const text = await post("/api/ingest", body);
    return { content: [{ type: "text", text }] };
  }
);

// ── tool: ingest_content ──────────────────────────────────────────────────────

server.registerTool(
  "gopedia_ingest_content",
  {
    description: `Ingest inline content (no source file) into the Gopedia knowledge graph.

Use for documents that have no file on disk — connector-style records (e.g. goquest
tickets) or ad-hoc text. For repo/git-backed markdown files use gopedia_ingest (path-based)
instead, so the document can be re-ingested and managed by its source_path.`,
    inputSchema: {
      title: z.string().describe("Document title"),
      content: z.string().describe("Markdown content body to ingest"),
      source: z
        .string()
        .optional()
        .describe("Logical source identifier; acts as the document's source_path (e.g. goquest/TASK-1)"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Optional tags attached to the document"),
      collection: z
        .string()
        .optional()
        .describe("Qdrant collection override (default: gopedia_markdown)"),
    },
  },
  async ({ title, content, source, tags, collection }) => {
    const body: Record<string, unknown> = { title, content };
    if (source !== undefined) body.source = source;
    if (tags !== undefined) body.tags = tags;
    if (collection !== undefined) body.collection = collection;

    const text = await post("/api/ingest_content", body);
    return { content: [{ type: "text", text }] };
  }
);

// ── tool: ingest_batch ───────────────────────────────────────────────────────

server.registerTool(
  "gopedia_ingest_batch",
  {
    description:
      "Ingest multiple documents under a logical project_root in one call (server-side register/ingest/finalize, optional prune). Use for folder contributions without sharing a filesystem path.",
    inputSchema: {
      project_root: z.string().describe("Logical project root that groups all documents in this batch"),
      documents: z
        .array(
          z.object({
            source: z.string().describe("Logical source identifier for the document (e.g. goquest/TASK-1)"),
            content: z.string().describe("Markdown content body to ingest"),
            title: z.string().optional().describe("Document title"),
            metadata: z.record(z.string(), z.unknown()).optional().describe("Arbitrary metadata attached to the document"),
          })
        )
        .min(1, "documents must contain at least one item")
        .describe("Array of documents to ingest under the project_root"),
      project_id: z
        .number()
        .int()
        .optional()
        .describe("Associate the batch with an existing project integer ID"),
      force: z
        .boolean()
        .optional()
        .describe("Force full re-ingest even if the project content hash is unchanged. Default: false."),
      prune: z
        .boolean()
        .optional()
        .describe("Remove documents in the project that are not in this batch. Default: false."),
    },
  },
  async ({ project_root, documents, project_id, force, prune }) => {
    const body: Record<string, unknown> = { project_root, documents };
    if (project_id !== undefined) body.project_id = project_id;
    if (force) body.force = true;
    if (prune) body.prune = true;

    const text = await post("/api/ingest/batch", body);
    return { content: [{ type: "text", text }] };
  }
);

// ── tool: delete ──────────────────────────────────────────────────────────────

server.registerTool(
  "gopedia_delete",
  {
    description: `Delete a document from the Gopedia knowledge graph by source_path.

Removes Qdrant vectors and all Postgres rows (L1/L2/L3) via CASCADE.
Use when a file has been removed from the source repo and should no longer appear in search results.`,
    inputSchema: {
      source_path: z
        .string()
        .describe("Absolute source path of the document to delete (e.g. /data/geneso/universitas/lymphhub/some-file.md)"),
    },
  },
  async ({ source_path }) => {
    const text = await del("/api/documents", { source_path });
    return { content: [{ type: "text", text }] };
  }
);

// ── tool: gardener health ─────────────────────────────────────────────────────

server.registerTool(
  "gardener_health",
  {
    description:
      "Check Gardener Gopedia eval service (GET /health). Optional Gopedia preflight: deps + sample search.",
    inputSchema: {
      gopedia_preflight: z
        .boolean()
        .optional()
        .describe("If true, also call Gopedia GET /api/health/deps and a sample search (default: false)"),
      probe_query: z
        .string()
        .optional()
        .describe("Sample search query when gopedia_preflight is true (default: osteon openstack)"),
    },
  },
  async ({ gopedia_preflight, probe_query }) => {
    const gh = await gardenerFetch("/health", { method: "GET", timeoutMs: 15_000 });
    const report: Record<string, unknown> = {
      gardener_base_url: GARDENER_BASE_URL,
      gardener_health_ok: gh.ok,
      gardener_health_status: gh.status,
      gardener_health: gh.body,
    };
    if (gopedia_preflight) {
      const deps = await get("/api/health/deps");
      const dq = probe_query ?? "osteon openstack";
      const sp = new URLSearchParams({ q: dq, format: "json", detail: "summary" });
      const search = await get(`/api/search?${sp.toString()}`);
      let depsParsed: unknown;
      let searchParsed: unknown;
      try {
        depsParsed = JSON.parse(deps);
      } catch {
        depsParsed = deps;
      }
      try {
        searchParsed = JSON.parse(search);
      } catch {
        searchParsed = search;
      }
      report["gopedia_preflight"] = {
        deps: depsParsed,
        search: searchParsed,
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  }
);

// ── tool: gardener quality run (full pipeline) ────────────────────────────────

server.registerTool(
  "gardener_quality_run",
  {
    description: `Run the Gardener retrieval quality pipeline end-to-end.

**Mode A — quality_preset (recommended):** POST /runs with e.g. quality_preset: "osteon" only (no dataset_id). Gardener loads dataset/sample_osteon_guide_30_v2.json, registers it like POST /datasets, sets resolve_before_eval=true and stores quality_preset in params_json.

**Mode B — dataset file:** POST /datasets from dataset_json_path → resolve-qrels → POST /runs with dataset_id.

Then: POST /runs/{id}/wait → metrics, kpi-summary, details, queries in the JSON report.

Requires Gardener and Gopedia HTTP APIs reachable.`,
    inputSchema: {
      quality_preset: z
        .string()
        .optional()
        .describe(
          'Bundled dataset key (e.g. "osteon"). Mutually exclusive with dataset_json_path. Skips manual POST /datasets + resolve-qrels.'
        ),
      dataset_json_path: z
        .string()
        .optional()
        .describe(
          "Absolute path to Gardener dataset JSON — required when quality_preset is omitted (queries + qrels)"
        ),
      unique_dataset_name: z
        .boolean()
        .optional()
        .describe("If true (default), append _run_<unix_ms> to dataset name (file mode only)"),
      gopedia_preflight: z.boolean().optional().describe("Preflight Gopedia before Gardener steps (default: true)"),
      probe_query: z.string().optional().describe("Sample search query for preflight"),
      resolve_target_url: z
        .string()
        .optional()
        .describe("Override Gopedia base URL for POST .../resolve-qrels (?target_url=)"),
      top_k: z.number().int().min(1).max(50).optional().describe("Retrieval depth (default: 10)"),
      search_detail: z.string().optional().describe("Gopedia search detail, e.g. summary (default: summary)"),
      resolve_before_eval: z
        .boolean()
        .optional()
        .describe("File mode only: resolve unresolved qrels before eval (default: true). Preset mode forces true on the server."),
      wait_timeout_ms: z.number().optional().describe("Max wait for eval run (default: 360000)"),
    },
  },
  async ({
    quality_preset,
    dataset_json_path,
    unique_dataset_name,
    gopedia_preflight,
    probe_query,
    resolve_target_url,
    top_k,
    search_detail,
    resolve_before_eval,
    wait_timeout_ms,
  }) => {
    const steps: Array<{ step: string; ok: boolean; detail?: unknown }> = [];
    const report: Record<string, unknown> = {
      ok: false,
      gardener_base_url: GARDENER_BASE_URL,
      gopedia_base_url: BASE_URL,
      steps,
    };

    const fail = (step: string, message: string, detail?: unknown) => {
      steps.push({ step, ok: false, detail: detail ?? message });
      report["ok"] = false;
      report["failure"] = { step, message, detail };
      return JSON.stringify(report, null, 2);
    };

    if (gopedia_preflight !== false) {
      const depsRaw = await get("/api/health/deps");
      let depsOk = false;
      try {
        const env = JSON.parse(depsRaw) as Envelope;
        depsOk = env.ok === true;
      } catch {
        depsOk = false;
      }
      steps.push({ step: "gopedia_health_deps", ok: depsOk, detail: safeJsonParse(depsRaw) });
      const pq = probe_query ?? "osteon openstack";
      const sp = new URLSearchParams({ q: pq, format: "json", detail: "summary" });
      const sRaw = await get(`/api/search?${sp.toString()}`);
      let searchOk = false;
      let nResults = 0;
      try {
        const env = JSON.parse(sRaw) as Envelope & { data?: { results?: unknown[] } };
        searchOk = env.ok === true;
        nResults = Array.isArray(env.data?.results) ? env.data!.results!.length : 0;
      } catch {
        searchOk = false;
      }
      steps.push({
        step: "gopedia_search_probe",
        ok: searchOk,
        detail: { result_count: nResults, raw: safeJsonParse(sRaw) },
      });
      report["gopedia_preflight"] = { deps: safeJsonParse(depsRaw), search_probe_results: nResults };
      if (!depsOk) return { content: [{ type: "text", text: fail("gopedia_preflight", "Gopedia /api/health/deps not ok") }] };
    }

    const preset = (quality_preset ?? "").trim();
    const path = (dataset_json_path ?? "").trim();
    if (preset && path) {
      return {
        content: [{ type: "text", text: fail("invalid_input", "Provide exactly one of quality_preset or dataset_json_path") }],
      };
    }
    if (!preset && !path) {
      return {
        content: [{ type: "text", text: fail("invalid_input", "Provide quality_preset (e.g. osteon) or dataset_json_path") }],
      };
    }

    let runBody: Record<string, unknown>;

    if (preset) {
      report["quality_preset"] = preset;
      runBody = {
        quality_preset: preset,
        top_k: top_k ?? 10,
        search_detail: search_detail ?? "summary",
      };
      steps.push({
        step: "gardener_quality_preset_mode",
        ok: true,
        detail: "POST /runs with quality_preset only (server loads bundled JSON, resolve_before_eval=true)",
      });
    } else {
      let rawJson: string;
      try {
        rawJson = await readFile(path, "utf-8");
      } catch (e) {
        return {
          content: [{ type: "text", text: fail("read_dataset", `Cannot read dataset_json_path: ${String(e)}`) }],
        };
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(rawJson) as Record<string, unknown>;
      } catch (e) {
        return {
          content: [{ type: "text", text: fail("parse_dataset", `Invalid JSON: ${String(e)}`) }],
        };
      }

      if (unique_dataset_name !== false) {
        const baseName = typeof payload["name"] === "string" ? payload["name"] : "dataset";
        payload["name"] = `${baseName}_run_${Date.now()}`;
      }

      const dsPost = await gardenerFetch("/datasets", { method: "POST", body: JSON.stringify(payload), timeoutMs: 120_000 });
      steps.push({ step: "gardener_post_dataset", ok: dsPost.ok, detail: { status: dsPost.status, body: dsPost.body } });
      if (!dsPost.ok) {
        return { content: [{ type: "text", text: fail("gardener_post_dataset", "POST /datasets failed", dsPost.body) }] };
      }

      const dsBody = dsPost.body as Record<string, unknown>;
      const datasetId = typeof dsBody["id"] === "string" ? dsBody["id"] : "";
      if (!datasetId) {
        return { content: [{ type: "text", text: fail("gardener_post_dataset", "No dataset id in response", dsBody) }] };
      }
      report["dataset_id"] = datasetId;
      report["dataset_name"] = dsBody["name"];

      let resolvePath = `/datasets/${encodeURIComponent(datasetId)}/resolve-qrels`;
      if (resolve_target_url?.trim()) {
        resolvePath += `?target_url=${encodeURIComponent(resolve_target_url.trim())}`;
      }
      const rq = await gardenerFetch(resolvePath, { method: "POST", timeoutMs: 180_000 });
      steps.push({ step: "gardener_resolve_qrels", ok: rq.ok, detail: { status: rq.status, body: rq.body } });
      if (!rq.ok) {
        return { content: [{ type: "text", text: fail("gardener_resolve_qrels", "POST .../resolve-qrels failed", rq.body) }] };
      }
      report["resolve_qrels"] = rq.body;

      runBody = {
        dataset_id: datasetId,
        top_k: top_k ?? 10,
        search_detail: search_detail ?? "summary",
        resolve_before_eval: resolve_before_eval !== false,
      };
    }

    const er = await gardenerFetch("/runs", { method: "POST", body: JSON.stringify(runBody), timeoutMs: 60_000 });
    steps.push({ step: "gardener_post_run", ok: er.ok, detail: { status: er.status, body: er.body } });
    if (!er.ok) {
      return { content: [{ type: "text", text: fail("gardener_post_run", "POST /runs failed", er.body) }] };
    }
    const erBody = er.body as Record<string, unknown>;
    const runId = typeof erBody["id"] === "string" ? erBody["id"] : "";
    if (!runId) {
      return { content: [{ type: "text", text: fail("gardener_post_run", "No run id in response", erBody) }] };
    }
    report["run_id"] = runId;
    if (preset && typeof erBody["dataset_id"] === "string") {
      report["dataset_id"] = erBody["dataset_id"];
    }

    const waitMs = wait_timeout_ms ?? 360_000;
    const wr = await gardenerFetch(`/runs/${encodeURIComponent(runId)}/wait`, {
      method: "POST",
      timeoutMs: waitMs + 10_000,
    });
    steps.push({ step: "gardener_wait_run", ok: wr.ok, detail: { status: wr.status, body: wr.body } });
    if (!wr.ok) {
      return { content: [{ type: "text", text: fail("gardener_wait_run", "POST .../wait failed or timeout", wr.body) }] };
    }
    report["run"] = wr.body;

    const wrBody = wr.body as Record<string, unknown>;
    if (wrBody["status"] === "failed") {
      report["ok"] = false;
      report["failure"] = { step: "eval_run", message: "Eval run status is failed", detail: wrBody["error_message"] };
    }

    const metricsRes = await gardenerFetch(`/runs/${encodeURIComponent(runId)}/metrics`, { method: "GET", timeoutMs: 60_000 });
    steps.push({ step: "gardener_metrics", ok: metricsRes.ok, detail: { status: metricsRes.status } });
    const metrics = metricsRes.ok ? metricsRes.body : [];
    report["metrics"] = metrics;
    report["aggregate_metrics"] = aggregateMetricsFromList(metrics);

    const kpi = await gardenerFetch(`/runs/${encodeURIComponent(runId)}/kpi-summary`, { method: "GET", timeoutMs: 30_000 });
    if (kpi.ok) report["kpi_summary"] = kpi.body;

    const detailsRes = await gardenerFetch(`/runs/${encodeURIComponent(runId)}/details`, { method: "GET", timeoutMs: 60_000 });
    if (detailsRes.ok) {
      const dBody = detailsRes.body as { rows?: Array<Record<string, unknown>> };
      const rows = Array.isArray(dBody.rows) ? dBody.rows : [];
      const recall5Zero = rows.filter((r) => recallAt5IsFailure(r["recall_at_5"]));
      report["details"] = dBody;
      report["recall_at_5_zero_count"] = recall5Zero.length;
      report["recall_at_5_zero_sample"] = recall5Zero.slice(0, 12);
    } else {
      steps.push({ step: "gardener_details", ok: false, detail: detailsRes.body });
    }

    const queriesRes = await gardenerFetch(`/runs/${encodeURIComponent(runId)}/queries`, { method: "GET", timeoutMs: 120_000 });
    if (queriesRes.ok) {
      const qrows = Array.isArray(queriesRes.body) ? (queriesRes.body as Record<string, unknown>[]) : [];
      const fails = qrows.filter((r) => (metricFromQueryRow(r, "Recall@5") ?? 0) === 0);
      report["queries_total"] = qrows.length;
      report["queries_recall5_zero_count"] = fails.length;
      report["queries_recall5_zero_sample"] = fails.slice(0, 10).map((r) => ({
        external_id: r["external_id"],
        query_text: typeof r["query_text"] === "string" ? r["query_text"].slice(0, 120) : r["query_text"],
        top1_title: Array.isArray(r["hits"]) && r["hits"][0] ? (r["hits"][0] as { title?: string }).title : undefined,
      }));
    }

    if (!report["failure"]) report["ok"] = wrBody["status"] === "completed";
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  }
);

// ── tool: gardener run report ─────────────────────────────────────────────────

server.registerTool(
  "gardener_run_report",
  {
    description:
      "Fetch a structured quality report for an existing Gardener eval run: GET /runs/{id}, /metrics, /kpi-summary, /details, /queries (failure samples).",
    inputSchema: {
      run_id: z.string().describe("Eval run UUID from gardener_quality_run or Gardener API"),
      include_queries: z.boolean().optional().describe("Include per-query rows sample (default: true)"),
      failure_sample_limit: z.number().int().min(1).max(50).optional().describe("Max Recall@5=0 rows to list (default: 10)"),
    },
  },
  async ({ run_id, include_queries, failure_sample_limit }) => {
    const rid = run_id.trim();
    const lim = failure_sample_limit ?? 10;
    const report: Record<string, unknown> = {
      ok: true,
      gardener_base_url: GARDENER_BASE_URL,
      run_id: rid,
    };

    const runRes = await gardenerFetch(`/runs/${encodeURIComponent(rid)}`, { method: "GET", timeoutMs: 30_000 });
    report["run"] = runRes.body;
    if (!runRes.ok) {
      report["ok"] = false;
      report["failure"] = "GET /runs/{id} failed";
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }

    const metricsRes = await gardenerFetch(`/runs/${encodeURIComponent(rid)}/metrics`, { method: "GET", timeoutMs: 60_000 });
    const metrics = metricsRes.ok ? metricsRes.body : [];
    report["metrics"] = metrics;
    report["aggregate_metrics"] = aggregateMetricsFromList(metrics);

    const kpi = await gardenerFetch(`/runs/${encodeURIComponent(rid)}/kpi-summary`, { method: "GET", timeoutMs: 30_000 });
    if (kpi.ok) report["kpi_summary"] = kpi.body;

    const detailsRes = await gardenerFetch(`/runs/${encodeURIComponent(rid)}/details`, { method: "GET", timeoutMs: 60_000 });
    if (detailsRes.ok) {
      const dBody = detailsRes.body as { rows?: Array<Record<string, unknown>> };
      const rows = Array.isArray(dBody.rows) ? dBody.rows : [];
      const recall5Zero = rows.filter((r) => recallAt5IsFailure(r["recall_at_5"]));
      report["details"] = dBody;
      report["recall_at_5_zero_count"] = recall5Zero.length;
      report["recall_at_5_zero_sample"] = recall5Zero.slice(0, lim);
    }

    if (include_queries !== false) {
      const queriesRes = await gardenerFetch(`/runs/${encodeURIComponent(rid)}/queries`, { method: "GET", timeoutMs: 120_000 });
      if (queriesRes.ok) {
        const qrows = Array.isArray(queriesRes.body) ? (queriesRes.body as Record<string, unknown>[]) : [];
        const fails = qrows.filter((r) => (metricFromQueryRow(r, "Recall@5") ?? 0) === 0);
        report["queries_total"] = qrows.length;
        report["queries_recall5_zero_count"] = fails.length;
        report["queries_recall5_zero_sample"] = fails.slice(0, lim).map((r) => ({
          external_id: r["external_id"],
          query_text: r["query_text"],
          top1_title: Array.isArray(r["hits"]) && r["hits"][0] ? (r["hits"][0] as { title?: string }).title : undefined,
          hits: Array.isArray(r["hits"]) ? r["hits"].slice(0, 3) : [],
        }));
      }
    }

    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  }
);

// ── tool: memory_save ────────────────────────────────────────────────────────

server.registerTool(
  "memory_save",
  {
    description: `Save a memory entry to the Gopedia memory subsystem (POST /api/memory/save).

Use to persist structured knowledge — project context, user feedback, reference snippets, or
agent-generated notes — that should survive across sessions. Returns the saved memory record.`,
    inputSchema: {
      Name: z.string().describe("Short identifier / title for this memory"),
      Description: z.string().describe("One-line description shown in index listings"),
      Body: z.string().describe("Full content of the memory (markdown supported)"),
      Type: z
        .enum(["user", "feedback", "project", "reference"])
        .describe("Memory type: user | feedback | project | reference"),
      Scope: z
        .enum(["global", "project"])
        .default("project")
        .describe("Visibility scope: global (all projects) or project (scoped to hint context)"),
      Tags: z
        .array(z.string())
        .default([])
        .describe("Optional tags for filtering"),
      Supersedes: z
        .array(z.string())
        .default([])
        .describe("UUIDs of memory entries this one replaces"),
      Pin: z
        .boolean()
        .default(false)
        .describe("Pin this memory so it is always included in recall results"),
      Source: z
        .enum(["user-explicit", "agent-auto", "imported"])
        .default("user-explicit")
        .describe("Origin of this memory"),
      TTLSeconds: z
        .number()
        .nullable()
        .default(null)
        .describe("Time-to-live in seconds; null means no expiry"),
      Hint: z
        .object({
          Explicit: z.string().default("").describe("Explicit project key override"),
          GitRemote: z.string().default("").describe("Git remote URL for project resolution"),
          Cwd: z.string().default("").describe("Working directory for project resolution"),
        })
        .default({ Explicit: "", GitRemote: "", Cwd: "" })
        .describe("Context hints used to resolve project scope"),
      DisableAssist: z
        .boolean()
        .default(false)
        .describe("If true, skip LLM auto-fill (assistFill) for this save. Use when you are providing fully-formed content and don't want the server to rewrite or enrich it."),
    },
  },
  async ({ Name, Description, Body, Type, Scope, Tags, Supersedes, Pin, Source, TTLSeconds, Hint, DisableAssist }) => {
    const body: Record<string, unknown> = {
      Name,
      Description,
      Body,
      Type,
      Scope,
      Tags,
      Supersedes,
      Pin,
      Source,
      TTLSeconds,
      Hint,
      DisableAssist,
    };
    const text = await post("/api/memory/save", body);
    return { content: [{ type: "text", text }] };
  }
);

// ── tool: memory_index ───────────────────────────────────────────────────────

server.registerTool(
  "memory_index",
  {
    description: `List memory entries visible in the current context (GET /api/memory/index).

Returns a lightweight index (id, name, description, type, scope, tags, created_at, pinned).
Use to browse what memories exist before doing a semantic recall or targeted get.`,
    inputSchema: {
      scope: z
        .enum(["current", "global", "both"])
        .default("both")
        .describe("Which scope to list: current project, global, or both"),
      type: z
        .string()
        .optional()
        .describe("Filter by memory type (user | feedback | project | reference)"),
      tag: z.string().optional().describe("Filter by a single tag"),
      project_key: z.string().optional().describe("Explicit project key override"),
      git_remote: z.string().optional().describe("Git remote URL for project resolution"),
      cwd: z.string().optional().describe("Working directory for project resolution"),
    },
  },
  async ({ scope, type, tag, project_key, git_remote, cwd }) => {
    const params = new URLSearchParams({ scope });
    if (type) params.set("type", type);
    if (tag) params.set("tag", tag);
    if (project_key) params.set("project_key", project_key);
    if (git_remote) params.set("git_remote", git_remote);
    if (cwd) params.set("cwd", cwd);
    const text = await get(`/api/memory/index?${params.toString()}`);
    return { content: [{ type: "text", text }] };
  }
);

// ── tool: memory_recall ──────────────────────────────────────────────────────

server.registerTool(
  "memory_recall",
  {
    description: `Semantic recall: retrieve the most relevant memories for a query (POST /api/memory/recall).

Performs vector similarity search over saved memories, optionally filtered by scope/type/tag.
Use at the start of a session to surface applicable context before doing other work.`,
    inputSchema: {
      Query: z.string().describe("Natural language query to match against memories"),
      Scope: z
        .string()
        .default("both")
        .describe("Scope to search: current | global | both"),
      Type: z.string().optional().describe("Filter by memory type"),
      Tag: z.string().optional().describe("Filter by tag"),
      IncludeScratch: z
        .boolean()
        .default(true)
        .describe("Include scratch (unconfirmed) memories in results"),
      TopK: z
        .number()
        .int()
        .default(8)
        .describe("Maximum number of results to return"),
      Hint: z
        .object({
          Explicit: z.string().default("").describe("Explicit project key override"),
          GitRemote: z.string().default("").describe("Git remote URL for project resolution"),
          Cwd: z.string().default("").describe("Working directory for project resolution"),
        })
        .default({ Explicit: "", GitRemote: "", Cwd: "" })
        .describe("Context hints used to resolve project scope"),
    },
  },
  async ({ Query, Scope, Type, Tag, IncludeScratch, TopK, Hint }) => {
    const body: Record<string, unknown> = { Query, Scope, IncludeScratch, TopK, Hint };
    if (Type !== undefined) body["Type"] = Type;
    if (Tag !== undefined) body["Tag"] = Tag;
    const text = await post("/api/memory/recall", body);
    return { content: [{ type: "text", text }] };
  }
);

// ── tool: memory_get ─────────────────────────────────────────────────────────

server.registerTool(
  "memory_get",
  {
    description: `Fetch a single memory entry by UUID (GET /api/memory/get?id=...).

Returns the full memory record including body, metadata, and provenance.
Use when you already have the id from memory_index or memory_recall.`,
    inputSchema: {
      id: z.string().uuid().describe("UUID of the memory entry to retrieve"),
    },
  },
  async ({ id }) => {
    const params = new URLSearchParams({ id });
    const text = await get(`/api/memory/get?${params.toString()}`);
    return { content: [{ type: "text", text }] };
  }
);

// ── tool: memory_forget ──────────────────────────────────────────────────────

server.registerTool(
  "memory_forget",
  {
    description: `Soft-delete (forget) a memory entry by UUID (POST /api/memory/forget).

Marks the entry as forgotten so it no longer appears in recall or index results.
Optionally records a reason for the deletion for audit purposes.`,
    inputSchema: {
      id: z.string().uuid().describe("UUID of the memory entry to forget"),
      reason: z.string().optional().describe("Optional reason for forgetting this memory"),
    },
  },
  async ({ id, reason }) => {
    const body: Record<string, unknown> = { id };
    if (reason !== undefined) body["reason"] = reason;
    const text = await post("/api/memory/forget", body);
    return { content: [{ type: "text", text }] };
  }
);

// ── tool: memory_scratch_list ─────────────────────────────────────────────────

server.registerTool(
  "memory_scratch_list",
  {
    description: `List scratch (unconfirmed/draft) memory entries (GET /api/memory/scratch).

Scratch memories are agent-auto-generated notes pending user confirmation.
Use to review and decide which scratch entries to promote to permanent memories.`,
    inputSchema: {
      scope: z
        .enum(["current", "global", "both"])
        .default("both")
        .describe("Which scope to list"),
      promotable: z
        .boolean()
        .default(false)
        .describe("If true, only return entries eligible for promotion"),
      project_key: z.string().optional().describe("Explicit project key override"),
      git_remote: z.string().optional().describe("Git remote URL for project resolution"),
      cwd: z.string().optional().describe("Working directory for project resolution"),
    },
  },
  async ({ scope, promotable, project_key, git_remote, cwd }) => {
    const params = new URLSearchParams({ scope, promotable: String(promotable) });
    if (project_key) params.set("project_key", project_key);
    if (git_remote) params.set("git_remote", git_remote);
    if (cwd) params.set("cwd", cwd);
    const text = await get(`/api/memory/scratch?${params.toString()}`);
    return { content: [{ type: "text", text }] };
  }
);

// ── tool: memory_import_claude_code ──────────────────────────────────────────

server.registerTool(
  "memory_import_claude_code",
  {
    description: `Import memories from a Claude Code MEMORY.md file (POST /api/memory/import/claude-code).

Reads a Claude Code memory markdown file and converts its entries into Gopedia memories.
Supports dry_run mode (default: true) to preview what would be imported without writing.`,
    inputSchema: {
      path: z
        .string()
        .describe("Absolute path to the Claude Code MEMORY.md (or similar) file to import"),
      scope: z
        .enum(["global", "project"])
        .default("project")
        .describe("Target scope for imported memories"),
      project_key: z.string().optional().describe("Explicit project key override"),
      git_remote: z.string().optional().describe("Git remote URL for project resolution"),
      cwd: z.string().optional().describe("Working directory for project resolution"),
      dry_run: z
        .boolean()
        .default(true)
        .describe("If true (default), preview the import without writing any data"),
    },
  },
  async ({ path, scope, project_key, git_remote, cwd, dry_run }) => {
    const body: Record<string, unknown> = { path, scope, dry_run };
    if (project_key !== undefined) body["project_key"] = project_key;
    if (git_remote !== undefined) body["git_remote"] = git_remote;
    if (cwd !== undefined) body["cwd"] = cwd;
    const text = await post("/api/memory/import/claude-code", body);
    return { content: [{ type: "text", text }] };
  }
);

// ── tool: memory_capabilities ─────────────────────────────────────────────────

server.registerTool(
  "memory_capabilities",
  {
    description: `Report the capabilities of the active memory provider (GET /api/memory/capabilities).

Returns a structured object describing which memory features are available (e.g. semantic recall,
proposals, scratch, LLM assist). Use to understand what operations are supported before calling
other memory_* tools.`,
  },
  async () => {
    const text = await get("/api/memory/capabilities");
    return { content: [{ type: "text", text }] };
  }
);

// ── tool: memory_proposals ────────────────────────────────────────────────────

server.registerTool(
  "memory_proposals",
  {
    description: `List pending memory proposals generated by the server-side proposer worker (GET /api/memory/proposals).

Proposals are agent-auto-generated memory candidates awaiting user review.
Use memory_proposal_accept / memory_proposal_skip / memory_proposal_reject to act on them.`,
    inputSchema: {
      scope: z
        .enum(["current", "global", "both"])
        .optional()
        .describe("Which scope to list: current project, global, or both (default: both)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum number of proposals to return"),
      project_key: z.string().optional().describe("Explicit project key override"),
      git_remote: z.string().optional().describe("Git remote URL for project resolution"),
      cwd: z.string().optional().describe("Working directory for project resolution"),
    },
  },
  async ({ scope, limit, project_key, git_remote, cwd }) => {
    const params = new URLSearchParams();
    if (scope) params.set("scope", scope);
    if (limit !== undefined) params.set("limit", String(limit));
    if (project_key) params.set("project_key", project_key);
    if (git_remote) params.set("git_remote", git_remote);
    if (cwd) params.set("cwd", cwd);
    const qs = params.toString();
    const text = await get(`/api/memory/proposals${qs ? `?${qs}` : ""}`);
    return { content: [{ type: "text", text }] };
  }
);

// ── tool: memory_proposal_accept ──────────────────────────────────────────────

server.registerTool(
  "memory_proposal_accept",
  {
    description: `Accept a memory proposal, optionally applying edits before promoting it (POST /api/memory/proposal/accept).

Promotes the proposal to a permanent memory entry. Pass edits to override specific fields
(e.g. correcting the Body or Tags) before the entry is written.`,
    inputSchema: {
      id: z.string().uuid().describe("UUID of the proposal to accept"),
      edits: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional field overrides to apply before promoting (e.g. { Body: '...', Tags: ['x'] })"),
    },
  },
  async ({ id, edits }) => {
    const body: Record<string, unknown> = { id };
    if (edits !== undefined) body["edits"] = edits;
    const text = await post("/api/memory/proposal/accept", body);
    return { content: [{ type: "text", text }] };
  }
);

// ── tool: memory_proposal_skip ────────────────────────────────────────────────

server.registerTool(
  "memory_proposal_skip",
  {
    description: `Skip a memory proposal (POST /api/memory/proposal/skip).

Marks the proposal as skipped without promoting or rejecting it. An optional cooldown period
prevents the same proposal from re-surfacing too quickly.`,
    inputSchema: {
      id: z.string().uuid().describe("UUID of the proposal to skip"),
      cooldown_hours: z
        .number()
        .min(0)
        .optional()
        .describe("Hours before this proposal may surface again (default: server-configured cooldown)"),
    },
  },
  async ({ id, cooldown_hours }) => {
    const body: Record<string, unknown> = { id };
    if (cooldown_hours !== undefined) body["cooldown_hours"] = cooldown_hours;
    const text = await post("/api/memory/proposal/skip", body);
    return { content: [{ type: "text", text }] };
  }
);

// ── tool: memory_proposal_reject ──────────────────────────────────────────────

server.registerTool(
  "memory_proposal_reject",
  {
    description: `Permanently reject a memory proposal (POST /api/memory/proposal/reject).

Marks the proposal as rejected so it is never promoted and will not re-surface.
Optionally records a reason for audit / feedback purposes.`,
    inputSchema: {
      id: z.string().uuid().describe("UUID of the proposal to reject"),
      reason: z
        .string()
        .optional()
        .describe("Optional human-readable reason for the rejection (used for audit / proposer feedback)"),
    },
  },
  async ({ id, reason }) => {
    const body: Record<string, unknown> = { id };
    if (reason !== undefined) body["reason"] = reason;
    const text = await post("/api/memory/proposal/reject", body);
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

// ── prompt: Gardener quality eval ─────────────────────────────────────────────

server.registerPrompt(
  "gardener_quality_guide",
  {
    description:
      "Instructions for running Gardener retrieval QA/eval against Gopedia: health checks, dataset path, full pipeline, and how to read the JSON report.",
  },
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `You can measure Gopedia retrieval quality with Gardener (HTTP API) via these MCP tools.

## Prerequisites
- Gopedia API running (default base from GOPEDIA_API_URL or GOPEDIA_HOST_DOMAIN, e.g. http://127.0.0.1:18787).
- Gardener API running (GARDENER_API_URL or GARDENER_HOST_DOMAIN, e.g. http://127.0.0.1:18880).
- Either a bundled **quality_preset** (e.g. osteon — see GET /config/defaults → quality_presets, quality_preset_files) or a local dataset JSON path.

## Recommended flow (preset — simplest)
1. gardener_health({ gopedia_preflight: true })
2. gardener_quality_run({
     quality_preset: "osteon",
     gopedia_preflight: true,
     top_k: 10,
     search_detail: "summary",
     wait_timeout_ms: 400000
   })
   Gardener POST /runs loads dataset/sample_osteon_guide_30_v2.json, registers it like POST /datasets, sets resolve_before_eval=true, stores quality_preset in params_json.

## Alternative (custom dataset file)
gardener_quality_run({ dataset_json_path: "<absolute path>", unique_dataset_name: true, ... }) — create dataset → resolve-qrels → POST /runs with dataset_id.
3. Parse the tool response JSON. Key fields:
   - aggregate_metrics — Recall@5, MRR@10, nDCG@10, P@3 (scope aggregate).
   - kpi_summary — quality/efficiency roll-up when available.
   - details.rows — per-query recall_at_5, top1_l3_id (GET /runs/{id}/details).
   - queries_recall5_zero_sample — queries where Recall@5 is 0, with hit snippets for debugging.

## Existing run id
- gardener_run_report({ run_id, failure_sample_limit: 10 }) — same report shape without re-running the pipeline.

## Environment
- GARDENER_API_URL overrides host/port for all Gardener calls.
- Resolve step uses Gardener's configured Gopedia URL unless you pass resolve_target_url on the run tool.

Always surface the numeric aggregate metrics and a short summary of failure samples when presenting results to the user.`,
        },
      },
    ],
  })
);

// ── start ─────────────────────────────────────────────────────────────────────

const httpPort = process.env["MCP_HTTP_PORT"] ? parseInt(process.env["MCP_HTTP_PORT"], 10) : undefined;

if (httpPort) {
  const { randomUUID } = await import("node:crypto");
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);
  const httpServer = createServer(async (req, res) => {
    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      process.stderr.write(`[mcp-http-error] ${err}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(String(err));
      }
    }
  });
  httpServer.listen(httpPort, () => {
    process.stderr.write(`gopedia-mcp HTTP listening on :${httpPort}\n`);
  });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
