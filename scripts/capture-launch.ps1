# Capture the GameForge launch handoff (see docs/launch.md, "The auto-login gap").
#
# Polls for gsl_metin2.exe / metin2client.* and dumps each process's full command line the moment it
# appears. gsl_metin2.exe exits ~2s after it spawns the client, so a one-shot query reliably misses
# it - hence the poll. What we're after is the client's argv, which the binaries show as:
#     metin2client  /startedFromGsl  /host=<pipe>  /msgId=<id>
#
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI and mangles UTF-8.
#
# Run ELEVATED (the client runs as admin; a non-elevated query returns a blank CommandLine), THEN
# click Play in the GameForge launcher:
#     powershell -ExecutionPolicy Bypass -File unforge\scripts\capture-launch.ps1

param([int]$Seconds = 120)

$seen = @{}
$deadline = (Get-Date).AddSeconds($Seconds)

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "NOT ELEVATED - CommandLine will come back blank for the client. Re-run as admin." -ForegroundColor Red
}

Write-Host "watching for gsl_metin2 / metin2client - click Play now (Ctrl+C to stop)" -ForegroundColor Cyan

while ((Get-Date) -lt $deadline) {
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name LIKE 'metin2client%' OR Name LIKE 'gsl_metin2%'" -ErrorAction Stop
  } catch {
    $procs = @()
  }

  foreach ($p in $procs) {
    if (-not $seen.ContainsKey($p.ProcessId)) {
      $seen[$p.ProcessId] = $true
      $parent = "?"
      try { $parent = (Get-Process -Id $p.ParentProcessId -ErrorAction Stop).ProcessName } catch { }
      Write-Host ("`n=== {0}  pid {1}  parent {2} ({3}) ===" -f $p.Name, $p.ProcessId, $p.ParentProcessId, $parent) -ForegroundColor Green
      Write-Host $p.CommandLine
    }
  }
  Start-Sleep -Milliseconds 150
}

Write-Host "`ndone - captured $($seen.Count) process(es)."
