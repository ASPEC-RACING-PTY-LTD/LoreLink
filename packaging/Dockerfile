# syntax=docker/dockerfile:1

FROM node:22-bookworm AS web
WORKDIR /src/web
COPY web/package.json web/pnpm-workspace.yaml web/pnpm-lock.yaml* ./
COPY web/shared/package.json ./shared/
COPY web/portal/package.json ./portal/
COPY web/docs-site/package.json ./docs-site/
RUN corepack enable && corepack prepare pnpm@10.10.0 --activate
RUN pnpm install --frozen-lockfile || pnpm install
COPY web ./
RUN pnpm install --frozen-lockfile || pnpm install
RUN pnpm --filter @lorelink/portal build && pnpm --filter @lorelink/docs-site build

FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.mod go.sum* ./
COPY . .
RUN go mod download
RUN CGO_ENABLED=0 go build -o /out/lorelink ./cmd/lorelink

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/lorelink /usr/local/bin/lorelink
COPY --from=web /src/web/portal/dist /app/web/portal
COPY --from=web /src/web/docs-site/dist /app/web/docs-site
ENV LORELINK_DATA_DIR=/data
ENV LORELINK_HTTP_ADDR=:8080
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["lorelink", "serve"]
