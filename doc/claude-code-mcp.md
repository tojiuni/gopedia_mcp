# Claude Code MCP Registration

Claude Code에서 `gopedia` MCP 서버를 전역 등록하는 방법입니다.

## 1) 설정 파일

파일: `~/.mcp.json`

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

`/path/to/gopedia_mcp`는 실제 로컬 경로로 교체해야 합니다.

## 2) 프롬프트 주입

Gopedia 질의 시작 시 아래 슬래시 명령으로 가이드를 주입합니다.

```text
/mcp__gopedia__gopedia_agent_guide
```

## 3) 확인 포인트

- Claude Code가 서버를 인식하고 도구 목록을 불러오는지 확인
- `gopedia_health` 호출로 API 연결 상태 확인
