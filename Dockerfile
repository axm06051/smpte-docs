FROM mcr.microsoft.com/dotnet/sdk:8.0 AS fetch

WORKDIR /app

COPY scripts/Get-SMPTEDocs.ps1 ./scripts/Get-SMPTEDocs.ps1

RUN pwsh -NoProfile -File scripts/Get-SMPTEDocs.ps1


FROM oven/bun:1.4.2 AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

COPY --from=fetch /app/.data ./.data

RUN bun run index \
    && test -s .data/searchindex.sqlite \
    && test -s .data/versions.json \
    && bun run build:app \
    && bun run build:mcp


FROM oven/bun:1.4.2

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=build /app/src ./src
COPY --from=build /app/dist ./dist
COPY --from=build /app/.data ./.data

USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "src/server.ts"]
