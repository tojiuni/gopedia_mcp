# Cursor MCP Registration

Cursor에서 `gopedia` MCP 서버를 프로젝트 단위로 등록하는 방법입니다.

## 1) 설정 파일

파일: `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "gopedia": {
      "command": "npx",
      "args": ["tsx", "gopedia-mcp-server.ts"],
      "cwd": "/path/to/gopedia_mcp"
    }
  }
}
```

- `cwd`는 프로젝트 절대 경로로 지정합니다.
- 이 레포에는 기본 `.cursor/mcp.json`이 포함되어 있어 바로 사용 가능합니다.

## 2) 확인 포인트

- Cursor에서 MCP 서버가 자동 인식되는지 확인
- 도구 목록에서 `gopedia_health`, `gopedia_search`, `gopedia_restore`, `gopedia_ingest` 노출 확인
