FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797
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
