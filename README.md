# gopedia_mcp

Gopedia HTTP API를 MCP 도구(`gopedia_health`, `gopedia_search`, `gopedia_ingest`)로 노출하는 TypeScript stdio 서버입니다.

## 요구사항

- Node.js 18+
- 실행 중인 Gopedia API (기본: `http://127.0.0.1:18787`)

## 설치

```bash
npm install
```

## 환경변수 (`.env`)

이 프로젝트는 `dotenv`를 사용하므로, 루트의 `.env`에서 Gopedia 호스트를 관리할 수 있습니다.

```env
# 기본 권장값 (host[:port] 형식)
GOPEDIA_HOST_DOMAIN=127.0.0.1:18787

# 필요 시 전체 URL로 우선 지정 가능
# GOPEDIA_API_URL=http://127.0.0.1:18787
```

우선순위:

1. `GOPEDIA_API_URL` (전체 URL)
2. `GOPEDIA_HOST_DOMAIN` (host[:port] 또는 URL)
3. 기본값 `127.0.0.1:18787`

## 실행

```bash
npm start
```

## MCP 도구

- `gopedia_health`: `GET /api/health/deps`
- `gopedia_search`: `GET /api/search?q=...&format=json`
- `gopedia_ingest`: `POST /api/ingest`

## 테스트

가이드 문서(`gopedia/doc/guide/mcp-testing.md`) 기준으로 현재 프로젝트에서 재현 가능한 스모크 테스트를 제공합니다.

```bash
# Gopedia API가 실행 중이어야 함
npm run test:mcp
```

테스트 수행 내용은 `data/logs/`에 JSON 로그로 저장됩니다.

테스트 항목:

1. MCP 연결 및 `tools/list`
2. `gopedia_health`
3. 기본 `gopedia_search` (`query=Introduction`, `detail=summary`)
4. ingest된 `gopedia`/`neunexus` 기반 난이도별 검색 시나리오
   - simple: 개요/핵심 키워드 탐색
   - intermediate: 컴포넌트/파이프라인 맥락 탐색
   - advanced: 아키텍처 비교/트레이드오프 근거 문맥 탐색 (`detail=full`)

## MCP 클라이언트 설정 예시

### Cursor/Claude Code 스타일 (`.mcp.json`)

```json
{
  "mcpServers": {
    "gopedia": {
      "command": "npx",
      "args": ["tsx", "/Users/dong-hoshin/Documents/dev/gopedia_mcp/gopedia-mcp-server.ts"]
    }
  }
}
```

### Cursor 프로젝트 설정 (`.cursor/mcp.json`)

이 저장소에는 Cursor에서 바로 인식할 수 있도록 `.cursor/mcp.json`도 포함되어 있습니다.

### Gemini CLI (`~/.gemini/settings.json`)

```json
{
  "mcp": {
    "servers": {
      "gopedia": {
        "command": "npx",
        "args": ["tsx", "/Users/dong-hoshin/Documents/dev/gopedia_mcp/gopedia-mcp-server.ts"],
        "env": {
          "GOPEDIA_HOST_DOMAIN": "127.0.0.1:18787"
        }
      }
    }
  }
}
```
