FROM node:26-alpine@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:26-alpine@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# The service runs with `node` only, so npm and npx (and the dependencies npm
# bundles) are removed from the runtime image once production modules are in.
# Optional typing peers of viem/ox also pull in the native TypeScript compiler;
# compilation belongs only in the builder stage.
RUN npm ci --omit=dev && npm cache clean --force \
  && rm -rf node_modules/typescript node_modules/@typescript \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
     /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /root/.npm
COPY --from=builder /app/dist ./dist
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
