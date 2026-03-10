$ErrorActionPreference = "Stop"

$uri = "http://127.0.0.1:3001/profile/stress-months?book=A&bank_code=SinoPac&from=2018-08&to=2018-08"

try {
    $resp = Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 5
} catch {
    Write-Host "FAIL: cannot reach server on 127.0.0.1:3001"
    exit 1
}

if ($resp.ok -ne 1) {
    Write-Host "FAIL: ok <> 1"
    $resp | ConvertTo-Json -Depth 6
    exit 1
}

if ($resp.version -ne "tel-api-profile-0.6.2") {
    Write-Host "FAIL: version mismatch"
    $resp | ConvertTo-Json -Depth 6
    exit 1
}

if ($resp.route -ne "/profile/stress-months") {
    Write-Host "FAIL: route mismatch"
    $resp | ConvertTo-Json -Depth 6
    exit 1
}

if ($resp.count -lt 1) {
    Write-Host "FAIL: count < 1"
    $resp | ConvertTo-Json -Depth 6
    exit 1
}

$row = $resp.rows | Select-Object -First 1

if ($row.month -ne "2018-08") {
    Write-Host "FAIL: first row month mismatch"
    $resp | ConvertTo-Json -Depth 6
    exit 1
}

Write-Host "PASS: /profile/stress-months smoke test"
$resp | ConvertTo-Json -Depth 6
exit 0
