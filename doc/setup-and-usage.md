# Setup and Usage

`gopedia-mcp-server`는 Gopedia HTTP API를 MCP 도구로 노출하는 TypeScript stdio 서버입니다.

## Requirements

- Node.js 18+
- 실행 중인 Gopedia API (기본: `http://127.0.0.1:18787`)

## Installation

```bash
npm install
```

## Environment (`.env`)

프로젝트 루트에 `.env` 파일을 생성하고 Gopedia 호스트를 설정합니다.

```env
# Recommended (host[:port] format)
GOPEDIA_HOST_DOMAIN=127.0.0.1:18787

# Override with a full URL if needed
# GOPEDIA_API_URL=http://127.0.0.1:18787
```

우선순위:
1. `GOPEDIA_API_URL` (full URL)
2. `GOPEDIA_HOST_DOMAIN` (host[:port] 또는 URL)
3. 기본값 `127.0.0.1:18787`

## Start

```bash
npm start
```

## MCP Tools

| Tool | HTTP | Description |
|------|------|-------------|
| `gopedia_health` | `GET /api/health/deps` | 서비스 및 의존성 상태 확인 |
| `gopedia_search` | `GET /api/search?format=json` | 시맨틱 검색 (기본 `detail=summary`) |
| `gopedia_restore` | `GET /api/restore` | PostgreSQL에서 섹션/문서 본문 복원 |
| `gopedia_ingest` | `POST /api/ingest` | Markdown 파일을 지식 그래프로 적재 |

### Response envelope

모든 도구는 아래 형태의 JSON envelope를 반환합니다.

```json
{
  "ok": true,
  "request_id": "abc123",
  "data": { "...": "..." },
  "failure": {
    "code": "NETWORK_ERROR",
    "message": "...",
    "retryable": true
  }
}
```

실패 시 `failure.retryable`을 기준으로 재시도 여부를 결정합니다.

## MCP Prompt: `gopedia_agent_guide`

서버는 Gopedia 탐색 절차를 안내하는 MCP 프롬프트를 등록합니다.

- 슬래시 명령: `/mcp__gopedia__gopedia_agent_guide`
- 목적: 검색 깊이를 단계적으로 올리면서 필요한 정보만 복원

### Escalation ladder

1. `gopedia_search(detail=summary)`
2. `gopedia_search(detail=standard)`
3. `gopedia_search(detail=full)`
4. `gopedia_restore(l2_id)`
5. `gopedia_restore(l1_id)` (필요할 때만)

## Tests

```bash
# Gopedia API must be running
npm run test:mcp
```

- 로그 경로: `data/logs/`
- 주요 시나리오:
  - MCP 연결 및 `tools/list`
  - `gopedia_health`
  - `gopedia_search` 기본 동작
  - 난이도별 검색 시나리오
