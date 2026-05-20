# syntax=docker/dockerfile:1
# CACHE: RUN --mount=type=cache 로 의존성 재사용. --no-cache/--pull 로 빌드하지 말 것
# (둘 다 cache mount 를 폐기해 매 빌드 전부 재다운로드함).
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

COPY gopedia-mcp-server.ts ./
COPY tsconfig.json ./

RUN --mount=type=cache,target=/root/.npm npm install -g tsx

ENV MCP_HTTP_PORT=8081
EXPOSE 8081

CMD ["tsx", "gopedia-mcp-server.ts"]
