param(
    [string]$IndexUrl = "https://pub.smpte.org/doc/",
    [string]$DataDir = ".\.data",
    [string]$OutDir = (Join-Path $DataDir "lib"),
    [int]$DelayMs = 200,
    [switch]$Force,
    [string[]]$Exts = @("pdf", "zip", "doc", "docx", "xml", "txt")
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$pdfUrlsFile = Join-Path $DataDir "pdf-urls.json"
$versionsFile = Join-Path $DataDir "versions.json"
if (-not $Force -and (Test-Path $pdfUrlsFile) -and (Test-Path $versionsFile) -and
    (Get-Item $pdfUrlsFile).Length -gt 0 -and (Get-Item $versionsFile).Length -gt 0 -and
    (Get-ChildItem -Path $OutDir -File -ErrorAction SilentlyContinue | Select-Object -First 1)) {
    Write-Host "Using existing download in $DataDir (pass -Force to refresh)."
    return
}

$base = [Uri]$IndexUrl

$extPattern = '\.(' + ($Exts -join '|') + ')$'
$visited = [System.Collections.Generic.HashSet[string]]::new()
$pdfUrls = [ordered]@{}

function Visit([Uri]$uri) {
    if (-not $visited.Add($uri.AbsoluteUri)) { return }

    if ($uri.AbsolutePath -match $extPattern) {
        $rel = $uri.AbsolutePath.TrimStart('/') -replace '/', '_'
        $dest = Join-Path $OutDir $rel
        if ($uri.AbsolutePath -match '\.pdf$') { $pdfUrls[$uri.AbsolutePath] = $uri.AbsoluteUri }
        if (Test-Path $dest) { return }
        Write-Host "  DL $dest"
        try {
            Invoke-WebRequest -Uri $uri.AbsoluteUri -OutFile $dest -UseBasicParsing
        }
        catch {
            Write-Warning "  fail $uri : $_"
        }
        Start-Sleep -Milliseconds $DelayMs
        return
    }

    if ($uri.AbsolutePath -notmatch '/$' -and $uri.AbsolutePath -notmatch '\.html?$') { return }
    if ($uri.Host -ne $base.Host) { return }

    Write-Host "Scan $uri"
    try {
        $html = (Invoke-WebRequest -Uri $uri.AbsoluteUri -UseBasicParsing).Content
    }
    catch {
        Write-Warning "  fail $uri : $_"
        return
    }
    Start-Sleep -Milliseconds $DelayMs

    $refs = @()
    $refs += [regex]::Matches($html, 'href\s*=\s*"([^"#]+)"') | ForEach-Object { $_.Groups[1].Value }
    $refs += [regex]::Matches($html, 'src\s*=\s*"([^"#]+)"') | ForEach-Object { $_.Groups[1].Value }

    foreach ($r in $refs) {
        if ($r -match '^(#|mailto:|javascript:|data:)') { continue }
        if ($r -match '\.(css|js|png|jpe?g|gif|svg|ico|woff2?)$') { continue }

        try { $abs = [Uri]::new($uri, $r) }
        catch { continue }

        if ($abs.Host -ne $base.Host) { continue }
        Visit $abs
    }
}

Visit $base

$versions = @{}
foreach ($url in $visited) {
    $path = ([Uri]$url).AbsolutePath
    if ($path -notmatch '^/doc/([^/]+)/([0-9]{8}-[a-z0-9-]+)/?$') { continue }

    $slug = $Matches[1].ToLowerInvariant()
    $key = $Matches[2].ToLowerInvariant()
    if (-not $versions.ContainsKey($slug)) { $versions[$slug] = @{} }
    $versions[$slug][$key] = @{ k = $key; s = "" }
}

$versionOutput = @{}
foreach ($slug in $versions.Keys) {
    $versionOutput[$slug] = @($versions[$slug].Values | Sort-Object { $_.k } -Descending)
}

$pdfUrls | ConvertTo-Json -Depth 2 | Set-Content -Encoding utf8 $pdfUrlsFile
$versionOutput | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 $versionsFile

Write-Host "Version metadata generated for $($versionOutput.Count) documents."
Write-Host "Done. Files in: $((Resolve-Path $OutDir).Path)"
