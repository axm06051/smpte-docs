# syntax=docker/dockerfile:1.7
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS fetch

WORKDIR /app

COPY scripts/Get-SMPTEDocs.ps1 ./scripts/Get-SMPTEDocs.ps1

COPY package.json .data* /seed/

# Force a refresh: docker build --build-arg FORCE=1 .
ARG FORCE=
RUN --mount=type=cache,target=/cache/smpte \
    mkdir -p /cache/smpte && rm -f /seed/package.json && cp -an /seed/. /cache/smpte/ \
    && pwsh -NoProfile -File scripts/Get-SMPTEDocs.ps1 -DataDir /cache/smpte -OutDir /cache/smpte/lib ${FORCE:+-Force} \
    && mkdir -p .data && cp -a /cache/smpte/. .data/


FROM oven/bun:1.4.2 AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY scripts/Build-SearchIndex.ts ./scripts/Build-SearchIndex.ts
COPY --from=fetch /app/.data ./.data
RUN bun run index \
    && test -s .data/searchindex.sqlite \
    && test -s .data/versions.json

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN bun run build:app && bun run build:mcp


FROM oven/bun:1.4.2

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=build /app/src ./src
COPY --from=build /app/dist ./dist
COPY --from=build /app/.data/searchindex.sqlite /app/.data/versions.json /app/.data/pdf-urls.json ./.data/

USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "src/server.ts"]
