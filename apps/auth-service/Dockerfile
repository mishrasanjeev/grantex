FROM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a
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
