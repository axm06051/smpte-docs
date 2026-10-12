# syntax=docker/dockerfile:1.7
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS fetch

WORKDIR /app

COPY scripts/Get-SMPTEDocs.ps1 ./scripts/Get-SMPTEDocs.ps1

COPY package.json .data* /seed/

# Force a refresh: docker build --build-arg FORCE=1 .
ARG FORCE=0
RUN --mount=type=cache,target=/cache/smpte \
    mkdir -p /cache/smpte && rm -f /seed/package.json && cp -an /seed/. /cache/smpte/ \
    && pwsh -NoProfile -File scripts/Get-SMPTEDocs.ps1 -DataDir /cache/smpte -OutDir /cache/smpte/lib ${FORCE:+-Force} \
    && mkdir -p .data && cp -a /cache/smpte/. .data/


# Only the PDFs feed the index; lib/ also holds ~3000 source .zip files (GBs) that never reach the
# build stage this way.  Docker compares the copied files, not the stage that produced them, so
# a re-run fetch that changed no PDF leaves the index layer below cached.
FROM fetch AS pdfs
RUN mkdir /pdfs && cd .data/lib && find . -iname '*.pdf' -exec cp --parents -t /pdfs {} +


FROM oven/bun:1.4.2 AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# The index depends on the PDFs only (not versions.json etc., which change on every fetch), so this
# layer is reused whenever no PDF changed; extracted text is kept in a cache mount so a changed PDF
# costs one OCR run, not all of them.
COPY scripts/Build-SearchIndex.ts ./scripts/Build-SearchIndex.ts
COPY --from=pdfs /pdfs ./.data/lib
RUN --mount=type=cache,target=/cache/index INDEX_CACHE=/cache/index bun run index \
    && test -s .data/searchindex.sqlite
COPY --from=fetch /app/.data/versions.json /app/.data/pdf-urls.json ./.data/
RUN test -s .data/versions.json

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

COPY public ./public
COPY --from=build /app/src ./src
COPY --from=build /app/dist ./dist
COPY --from=build /app/.data/searchindex.sqlite /app/.data/versions.json /app/.data/pdf-urls.json ./.data/

USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "src/server.ts"]
