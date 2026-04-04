# Gopedia MCP Quick Install Guide

`gopedia_mcp`를 5분 내 설치해 Agent에서 Gopedia 검색을 사용하는 요약 가이드입니다.

## 사전 요구 사항 (최소)

- `node 18+`, `npm`
- 실행 중인 Gopedia API
- `.env`의 `GOPEDIA_HOST_DOMAIN`

## 설치 (복사-붙여넣기)

```bash
cd /neunexus/gopedia_mcp
cp .env.example .env
sed -i 's|^GOPEDIA_HOST_DOMAIN=.*|GOPEDIA_HOST_DOMAIN=http://127.0.0.1:18787|' .env
npm install
npm start
```

## 설치 확인

- MCP 클라이언트에서 `gopedia_health` 호출
- 이어서 `gopedia_search` 호출
- 두 호출이 정상 응답이면 성공

## 삭제

```bash
pkill -f "gopedia-mcp-server" || true
```

## 10분 첫 시나리오 (Obsidian 권장)

1. Obsidian 문서를 Gopedia에 ingest
2. Agent에서 `gopedia_search`로 질의
3. 필요 시 Gardener로 동일 질의 품질 측정

## 3개 조합 확장

- 플랫폼: `gopedia`
- 품질 관리: `gardener_gopedia`
- Agent 활용: `gopedia_mcp`

상세는 [install-guide.md](./install-guide.md) 참고.
