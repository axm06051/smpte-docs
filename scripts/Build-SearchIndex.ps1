[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path .data/lib | Out-Null
& bun run Build-SearchIndex.ts
if ($LASTEXITCODE -ne 0) { throw "Build-SearchIndex.ts failed with exit code $LASTEXITCODE" }
