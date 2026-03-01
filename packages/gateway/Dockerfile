FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig*.json ./
COPY src/ src/
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/dist/ dist/

EXPOSE 8080
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--config", "/etc/grantex/gateway.yaml"]
