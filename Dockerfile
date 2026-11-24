# Multi-stage image used for both the web app and the worker.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN useradd --system --uid 1001 salesarmy
COPY --from=build /app /app
USER salesarmy
EXPOSE 3000
# Web:    docker run … (default)
# Worker: docker run … npm run worker
# Migrate: docker run … npm run db:migrate
CMD ["npm", "run", "start"]
