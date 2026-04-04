# Gopedia MCP Install Guide (Detailed)

이 문서는 `gopedia_mcp`를 설치해 Gopedia를 MCP 도구로 노출하고, Agent(Cursor/Claude/Gemini)에서 바로 활용하는 절차를 설명합니다. `gopedia`, `gardener_gopedia`와의 통합 시나리오를 포함합니다.

## 1) 사전 요구 사항

### 최소 환경

- Kubernetes: `v1.28+` (또는 로컬 Node 실행)
- CPU/Memory(개발 최소): `2 vCPU / 2GB RAM`
- 권장(3개 조합): `8 vCPU / 16GB RAM` (Gopedia + Gardener + MCP 동시)

### 필수 도구

- `git`
- `node 18+`, `npm`
- 실행 중인 `gopedia` API (`127.0.0.1:18787`)

### 필수 환경값

- `.env`의 `GOPEDIA_HOST_DOMAIN` (예: `http://127.0.0.1:18787`)

## 2) 설치 (5분 이내)

```bash
cd /neunexus/gopedia_mcp
cp .env.example .env
sed -i 's|^GOPEDIA_HOST_DOMAIN=.*|GOPEDIA_HOST_DOMAIN=http://127.0.0.1:18787|' .env
npm install
npm start
```

## 3) 설치 확인 방법

MCP 클라이언트에서 아래 도구 호출:

- `gopedia_health`
- `gopedia_search`

성공 기준:

- `gopedia_health`가 정상 상태를 반환
- `gopedia_search`가 검색 결과 JSON을 반환

## 4) 삭제 방법

```bash
pkill -f "gopedia-mcp-server" || true
```

또는 실행 터미널에서 `Ctrl+C`.

## 5) 3개 조합 통합 시나리오

### A. Gopedia + MCP

1. Gopedia API 기동
2. MCP 서버 실행
3. Agent에서 `gopedia_search`로 질의 수행

### B. MCP + Gardener (품질 폐루프)

1. Agent 질의/응답 사례를 Gardener 질의셋으로 등록
2. 반복 측정으로 프롬프트/인덱스 품질 개선

### C. Full Stack (Gopedia + Gardener + MCP)

1. Gopedia ingest/검색
2. MCP로 Agent 사용성 검증
3. Gardener로 정량 품질 회귀 관리

## 6) 첫 번째 시나리오 (10분 이내, Obsidian 권장)

1. Obsidian 문서를 Gopedia에 ingest
2. Agent에서 `gopedia_search`로 문서 요약 질의
3. 동일 질의를 Gardener에 등록해 기준 점수 생성
4. 이후 인덱스/프롬프트 변경 시 재측정

Obsidian 권장 이유:

- Markdown 기반이라 Agent 질의/검색 결과 확인이 직관적

## 7) 관련 문서

- 요약 설치: [quick-install-guide.md](./quick-install-guide.md)
- 서버 상세 사용: [../setup-and-usage.md](../setup-and-usage.md)
- Cursor 등록: [../cursor-mcp.md](../cursor-mcp.md)
