# gopedia-mcp-server

A TypeScript stdio MCP server that exposes the [Gopedia](https://github.com/lyckabc/gopedia) HTTP API as MCP tools, enabling AI agents (Claude Code, Cursor, Gemini CLI, etc.) to search, restore, and ingest a structured knowledge graph.

## Requirements

- Node.js 18+
- A running Gopedia API (default: `http://127.0.0.1:18787`)

## Installation

```bash
npm install
```

## Environment (`.env`)

This project uses `dotenv`. Configure the Gopedia host in a `.env` file at the project root.

```env
# Recommended (host[:port] format)
GOPEDIA_HOST_DOMAIN=127.0.0.1:18787

# Override with a full URL if needed
# GOPEDIA_API_URL=http://127.0.0.1:18787
```

Priority order:
1. `GOPEDIA_API_URL` (full URL)
2. `GOPEDIA_HOST_DOMAIN` (host[:port] or URL)
3. Default `127.0.0.1:18787`

## Start

```bash
npm start
```

---

## MCP Tools

| Tool | HTTP | Description |
|------|------|-------------|
| `gopedia_health` | `GET /api/health/deps` | Check service and dependency status |
| `gopedia_search` | `GET /api/search?format=json` | Semantic search (default `detail=summary`) |
| `gopedia_restore` | `GET /api/restore` | Fetch full section or document from PostgreSQL |
| `gopedia_ingest` | `POST /api/ingest` | Ingest markdown files into the knowledge graph |

### Response envelope

Every tool returns a consistent JSON envelope:

```json
{
  "ok": true,
  "request_id": "abc123",
  "data": { ... },
  "failure": {
    "code": "NETWORK_ERROR",
    "message": "...",
    "retryable": true
  }
}
```

Check `failure.retryable` before retrying a failed call.

---

## MCP Prompt — `gopedia_agent_guide`

The server registers one MCP prompt that teaches an AI agent how to explore Gopedia step-by-step using the tools above.

**In Claude Code**, inject it as a slash command:

```
/mcp__gopedia__gopedia_agent_guide
```

This inserts the full exploration guide into the conversation context so the agent follows the escalation ladder on every subsequent Gopedia query.

### What the prompt covers

- **Escalation ladder** — start with `summary`, stop as soon as context is sufficient
- **When to call `gopedia_restore`** — only after a search returns `l2_id`/`l1_id` pointers
- **Comparison queries** — run independent searches per concept, restore top hits, synthesise
- **Multi-step abstract queries** — decompose into 2–3 focused searches, collect pointers, restore selectively
- **Citation format** — every answer must include `source_path § section_heading (l2_id: <uuid>)`

### Escalation ladder (summary)

```
1. gopedia_search(detail=summary)     ← always start here
2. gopedia_search(detail=standard)    ← when l2_id/l1_id pointers are needed
3. gopedia_search(detail=full)        ← when surrounding_context is required
4. gopedia_restore(l2_id)             ← full section body
5. gopedia_restore(l1_id)             ← full document body (use sparingly)
```

---

## Client Configuration

### Claude Code (global, all projects)

Register the server globally by adding it to `~/.mcp.json`:

```json
{
  "mcpServers": {
    "gopedia": {
      "command": "npx",
      "args": ["tsx", "/path/to/gopedia_mcp/gopedia-mcp-server.ts"],
      "env": {
        "GOPEDIA_HOST_DOMAIN": "127.0.0.1:18787"
      }
    }
  }
}
```

Then inject the agent guide at the start of any Gopedia session:

```
/mcp__gopedia__gopedia_agent_guide
```

### Cursor (project-level, `.cursor/mcp.json`)

This repository includes a `.cursor/mcp.json` so Cursor picks up the server automatically.

### Gemini CLI (`~/.gemini/settings.json`)

```json
{
  "mcp": {
    "servers": {
      "gopedia": {
        "command": "npx",
        "args": ["tsx", "/path/to/gopedia_mcp/gopedia-mcp-server.ts"],
        "env": {
          "GOPEDIA_HOST_DOMAIN": "127.0.0.1:18787"
        }
      }
    }
  }
}
```

---

## Tests

```bash
# Gopedia API must be running
npm run test:mcp
```

Logs are written to `data/logs/` as JSON.

Test scenarios:
1. MCP connection and `tools/list`
2. `gopedia_health`
3. Basic `gopedia_search` (`detail=summary`)
4. Difficulty-graded search scenarios (simple → intermediate → advanced)
