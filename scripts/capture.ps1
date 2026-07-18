# One-shot GameForge capture: enable the Windows system proxy, run mitmdump with
# the gf-capture addon, and restore the proxy on exit (even on Ctrl+C).
#
# The proxy toggle is the step that's easy to forget when running mitmdump by hand:
# without it, the launcher's traffic never reaches the proxy and nothing is
# captured. CEF reads the system proxy at startup, so start this BEFORE the launcher.
#
#   scripts\capture.cmd        (double-click or run)
#   pwsh -File scripts\capture.ps1
#
# Output: scripts\captures\gf-<timestamp>.jsonl (see gf-capture.py), one per run,
# gitignored. The mitmproxy CA must be trusted first (see docs/capturing-traffic.md).

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'

# Find mitmdump: PATH first, then the standalone binary under ~\tools\mitm.
$mitm = (Get-Command mitmdump -ErrorAction SilentlyContinue).Source
if (-not $mitm) { $mitm = Join-Path $env:USERPROFILE 'tools\mitm\mitmdump.exe' }
if (-not (Test-Path $mitm)) {
    throw 'mitmdump not found. Install mitmproxy or add mitmdump to PATH.'
}

# Mark the run start so the summary only counts a file THIS run created — otherwise
# a run that captures nothing falsely reports the previous capture's line count.
$startedAt = Get-Date
Set-ItemProperty -Path $key -Name ProxyServer -Value '127.0.0.1:8080'
Set-ItemProperty -Path $key -Name ProxyEnable -Value 1
Write-Host ''
Write-Host '  Proxy ON (127.0.0.1:8080). Capture running.' -ForegroundColor Cyan
Write-Host '  Log OUT, then log in fresh (email + password) and click Play.' -ForegroundColor Cyan
Write-Host '  [captured] lines appear below. Press Ctrl+C when the login is done.' -ForegroundColor Cyan
Write-Host ''
try {
    & $mitm -s (Join-Path $here 'gf-capture.py') `
        --listen-port 8080 `
        --allow-hosts '(spark|pow-captcha|lpc|image-drop-challenge)\.gameforge\.com' `
        --set connection_strategy=lazy
}
finally {
    Set-ItemProperty -Path $key -Name ProxyEnable -Value 0
    Remove-ItemProperty -Path $key -Name ProxyServer -ErrorAction SilentlyContinue
    Write-Host ''
    Write-Host '  Proxy OFF.' -ForegroundColor Yellow
    $latest = Get-ChildItem (Join-Path $here 'captures') -Filter 'gf-*.jsonl' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -gt $startedAt } |
        Sort-Object LastWriteTime | Select-Object -Last 1
    if ($latest) {
        $n = (Get-Content $latest.FullName | Measure-Object -Line).Lines
        Write-Host "  Captured $n request(s) -> scripts\captures\$($latest.Name)" -ForegroundColor Yellow
        # Snapshot the launcher console log alongside it: it is a rolling file and the
        # only record of the conditional PoW-captcha flow (see docs/pow-captcha.md).
        $browserLog = Join-Path $env:LOCALAPPDATA 'Gameforge4d\GameforgeClient\browser.log'
        if (Test-Path $browserLog) {
            $snap = Join-Path (Join-Path $here 'captures') ($latest.BaseName + '.browser.log')
            Copy-Item $browserLog $snap -Force
            if (Select-String -Path $snap -Pattern 'pow-captcha' -Quiet) {
                Write-Host '  browser.log snapshotted (contains pow-captcha entries).' -ForegroundColor Cyan
            } else {
                Write-Host '  browser.log snapshotted.' -ForegroundColor Yellow
            }
        }
    } else {
        Write-Host '  Nothing captured. Was the login a fresh email+password login (not a cached resume)?' -ForegroundColor Yellow
    }
}
