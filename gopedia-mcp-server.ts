#!/usr/bin/env node
/**
 * Gopedia MCP Server
 *
 * Exposes Gopedia's HTTP API as MCP tools so AI agents (Claude Code, etc.)
 * can search, ingest, and inspect the knowledge graph directly.
 *
 * Tools:
 *   gopedia_health  — GET /api/health/deps
 *   gopedia_search  — GET /api/search?q=...&format=json
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

// ── helpers ──────────────────────────────────────────────────────────────────

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: res.status };
  }
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: res.status };
  }
}

function toText(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

// ── server ────────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "gopedia",
  version: "1.0.0",
});

// ── tool: health ──────────────────────────────────────────────────────────────

server.registerTool(
  "gopedia_health",
  {
    description: "Check Gopedia service health and dependency status (Postgres, Qdrant, TypeDB, Phloem).",
  },
  async () => {
    const data = await get("/api/health/deps");
    return { content: [{ type: "text", text: toText(data) }] };
  }
);

// ── tool: search ──────────────────────────────────────────────────────────────

server.registerTool(
  "gopedia_search",
  {
    description: `Search the Gopedia knowledge graph using semantic search (Xylem pipeline).

detail presets (controls which fields are returned):
  summary  — doc_id, doc_name, l3_id, score, title, snippet, source_path (cheapest)
  standard — summary + project_id, l1_id, l2_id, section_heading, breadcrumb
  full     — all fields including surrounding_context (default)

fields — comma-separated list of exact field names; overrides detail when provided.
         Valid keys: doc_id, doc_name, project_id, l1_id, l2_id, l3_id, score, title,
         section_heading, snippet, source_path, breadcrumb, surrounding_context`,
    inputSchema: {
      query: z.string().describe("Search query text"),
      detail: z
        .enum(["summary", "standard", "full"])
        .optional()
        .describe("Field preset — summary | standard | full (default: full)"),
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
    if (detail) params.set("detail", detail);
    if (fields) params.set("fields", fields);
    if (project_id !== undefined) params.set("project_id", String(project_id));

    const data = await get(`/api/search?${params.toString()}`);
    return { content: [{ type: "text", text: toText(data) }] };
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

    const data = await post("/api/ingest", body);
    return { content: [{ type: "text", text: toText(data) }] };
  }
);

// ── start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
