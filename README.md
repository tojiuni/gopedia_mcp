# gopedia-mcp-server

`gopedia-mcp-server`는 [Gopedia](https://github.com/tojiuni/gopedia) HTTP API를 MCP 도구로 노출하는 TypeScript stdio 서버입니다.

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

- 상세 설치 가이드: [`doc/guide/install-guide.md`](doc/guide/install-guide.md)
- 요약 설치 가이드: [`doc/guide/quick-install-guide.md`](doc/guide/quick-install-guide.md)
- 서버 설치/환경변수/도구/프롬프트/테스트: [`doc/setup-and-usage.md`](doc/setup-and-usage.md)
- Claude Code 등록: [`doc/claude-code-mcp.md`](doc/claude-code-mcp.md)
- Gemini CLI 등록: [`doc/gemini-cli-mcp.md`](doc/gemini-cli-mcp.md)
- Cursor 등록: [`doc/cursor-mcp.md`](doc/cursor-mcp.md)

## 설치/시나리오 가이드 (Korean)

사전 요구 사항 : 설치에 필요한 최소 환경 (K8s 버전, CPU/Memory, 필수 도구 등)

- K8s `v1.28+` 또는 Node 기반 로컬 실행 환경
- 최소 `2 vCPU / 2GB RAM` (3개 조합 권장 `8 vCPU / 16GB RAM`)
- 필수 도구: `git`, `node 18+`, `npm`, 실행 중인 Gopedia API

설치 (5분 이내)

- 복사-붙여넣기 가능한 설치 명령어 (Helm 또는 kubectl)
- 빠른 설치 명령은 가이드 문서에 포함
- 상세: [`doc/guide/install-guide.md`](doc/guide/install-guide.md)
- 요약: [`doc/guide/quick-install-guide.md`](doc/guide/quick-install-guide.md)

설치 확인 방법 ("이 화면이 뜨면 성공")

- MCP 클라이언트에서 `gopedia_health` 호출 성공
- 이어서 `gopedia_search`가 결과 JSON 반환 시 정상

삭제 방법

- `pkill -f "gopedia-mcp-server" || true`

첫 번째 시나리오 (10분 이내)

- 설치 직후 바로 실행할 수 있는 데모 시나리오 1개
- Obsidian 문서를 Gopedia에 ingest한 뒤 Agent에서 `gopedia_search` 실행
- 동일 질의를 Gardener에 등록해 회귀 품질 관측

다음 단계 안내 : 프로덕션 적용을 원하시면 [contact@cloudbro.ai](mailto:contact@cloudbro.ai)로 문의 - 컨택 채널은 꼭 cloudbro로 부탁드립니다!

## Test

```bash
npm run test:mcp
```
