FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY gopedia-mcp-server.ts ./
COPY tsconfig.json ./

RUN npm install -g tsx

ENV MCP_HTTP_PORT=8081
EXPOSE 8081

CMD ["tsx", "gopedia-mcp-server.ts"]
