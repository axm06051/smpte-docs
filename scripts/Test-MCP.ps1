$ErrorActionPreference = 'Stop'

$port = $env:PORT
if (-not $port) { $port = '3000'}

$base = "http://localhost:$port/mcp"
$headers = @{
  'Content-Type' = 'application/json'
  'Accept' = 'application/json, text/event-stream'
}

function Invoke-Mcp($id, $method, $params = @{}) {
  $body = @{
    jsonrpc = '2.0'
    id      = $id
    method  = $method
    params  = $params
  } | ConvertTo-Json -Depth 10 -Compress

  Write-Host "`n=== $method ===" -ForegroundColor Cyan
  Write-Host "Request:"
  Write-Host $body

  $response = Invoke-WebRequest `
    -Uri $base `
    -Method POST `
    -Headers $headers `
    -Body $body

  return $response
}

Write-Host "Testing $base"

Invoke-Mcp 1 'initialize' @{
  protocolVersion = '2025-06-18'
  capabilities    = @{}
  clientInfo      = @{
    name    = 'mcp-test'
    version = '1.0.0'
  }
}

Invoke-Mcp 2 'tools/list'

Invoke-Mcp 3 'tools/call' @{
  name      = 'search_smpte'
  arguments = @{
    q     = 'HDR metadata signaling'
    limit = 5
  }
}

Invoke-Mcp 4 'resources/list'

Invoke-Mcp 5 'resources/read' @{
  uri = 'smpte://doc/st2081-10'
}

Write-Host "`n=== MCP TEST COMPLETE ===" -ForegroundColor Green