# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS dependencies

WORKDIR /opt/sovereign
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

ENV NODE_ENV=production
WORKDIR /opt/sovereign
COPY --from=dependencies /opt/sovereign/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json model.config.json local-providers.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node deployment/local-providers.json ./deployment/local-providers.json
COPY --chown=node:node phaseB/residency-inventory.v1.json ./phaseB/residency-inventory.v1.json

USER node
CMD ["node", "scripts/verify-deployment-runtime.ts"]
