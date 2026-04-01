# gopedia-mcp-server

`gopedia-mcp-server`는 [Gopedia](https://github.com/lyckabc/gopedia) HTTP API를 MCP 도구로 노출하는 TypeScript stdio 서버입니다.

## Quick Start

```bash
npm install
npm start
```

기본 환경:
- Node.js 18+
- 실행 중인 Gopedia API (`127.0.0.1:18787`)
- 프로젝트 루트 `.env`에 `GOPEDIA_HOST_DOMAIN` 설정

## Included MCP Tools

- `gopedia_health`
- `gopedia_search`
- `gopedia_restore`
- `gopedia_ingest`
- MCP prompt: `gopedia_agent_guide`

## Documentation

상세 설명은 아래 문서로 분리되어 있습니다.

- 서버 설치/환경변수/도구/프롬프트/테스트: [`doc/setup-and-usage.md`](doc/setup-and-usage.md)
- Claude Code 등록: [`doc/claude-code-mcp.md`](doc/claude-code-mcp.md)
- Gemini CLI 등록: [`doc/gemini-cli-mcp.md`](doc/gemini-cli-mcp.md)
- Cursor 등록: [`doc/cursor-mcp.md`](doc/cursor-mcp.md)

## Test

```bash
npm run test:mcp
```
