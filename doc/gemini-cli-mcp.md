# Gemini CLI MCP Registration

Gemini CLI에서 `gopedia` MCP 서버를 등록하는 방법입니다.

## 방법 A) CLI 명령으로 등록 (권장)

프로젝트 루트에서 실행:

```bash
gemini mcp add gopedia npx tsx "/path/to/gopedia_mcp/gopedia-mcp-server.ts"
```

등록 확인:

```bash
gemini mcp list
```

## 방법 B) 설정 파일로 등록

프로젝트 단위 설정 파일: `.gemini/settings.json`

```json
{
  "mcpServers": {
    "gopedia": {
      "command": "npx",
      "args": ["tsx", "/path/to/gopedia_mcp/gopedia-mcp-server.ts"]
    }
  }
}
```

필요 시 `GOPEDIA_HOST_DOMAIN`은 프로젝트 루트 `.env`에서 관리하는 것을 권장합니다.

## 확인 포인트

- `gemini mcp list`에서 `gopedia`가 표시되는지 확인
- 상태가 `Connected`인지 확인
