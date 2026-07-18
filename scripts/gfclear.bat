@echo off
setlocal
REM ============================================================================
REM  gfclear.bat - reset local GameForge client state.
REM
REM  Force-closes the GF client + Metin2 and wipes local GF state: caches, the
REM  web-auth session, and the HardwareId/InstallationId registry fingerprint.
REM
REM  TWO USES:
REM   1. Fresh-login capture: clearing the web-auth session forces the next launch
REM      to do a real `sessions` login (not a cached token) - what capturing the
REM      login flow needs. See docs/capturing-traffic.md.
REM   2. Red-bar "HWID/fingerprint" reset. NOTE the common SOFT red bar is
REM      ACCOUNT-LEVEL and SELF-CLEARING (keyed on the account, not this PC/IP) -
REM      nothing local clears it; just WAIT ~12-24h and use a spare account. Only the
REM      fingerprint wipe below helps the rarer IP/HWID variant, which you can tell
REM      apart because a spare account ALSO fails on the same machine.
REM
REM  Wiping the registry fingerprint changes the InstallationId, i.e. a NEW device
REM  identity - fine for a red-bar reset, but for a pure fresh-login capture a plain
REM  logout is enough; only nuke the fingerprint if you also want a clean device.
REM
REM  GAME_DIR (the client install, for wiping its UserData/syserr) is optional -
REM  pass it as the first arg or set UNFORGE_GAME_DIR; if unset, that wipe is skipped.
REM  Run AS ADMINISTRATOR.
REM ============================================================================

set "GAME_DIR=%~1"
if "%GAME_DIR%"=="" set "GAME_DIR=%UNFORGE_GAME_DIR%"

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo [X] Must be run as Administrator. Right-click ^> Run as administrator.
  pause
  exit /b 1
)

echo.
echo  This will FORCE-CLOSE the GameForge client + all Metin2 clients and delete:
echo    - GF web-auth session + client caches/fingerprint state (LocalAppData/ProgramData)
echo    - the GF HardwareId / InstallationId registry values
if not "%GAME_DIR%"=="" echo    - the game's UserData + syserr under: %GAME_DIR%
echo    - Windows temp, prefetch and crash-report (WER) archives
echo.
echo  Press Ctrl+C to abort, or
pause

echo [*] Closing GameForge + Metin2 processes...
taskkill /F /IM metin2client.exe   >nul 2>&1
taskkill /F /IM gfclient.exe        >nul 2>&1
taskkill /F /IM gfservice.exe       >nul 2>&1
taskkill /F /IM SparkWebHelper.exe  >nul 2>&1
taskkill /F /IM gfHelper.exe        >nul 2>&1

echo [*] Clearing GameForge client caches + web-auth session + state...
RD /S /Q "C:\Program Files (x86)\GameforgeClient\GPUCache" 2>nul
RD /S /Q "%LocalAppData%\Gameforge4d"                      2>nul
RD /S /Q "C:\ProgramData\Gameforge4d"                      2>nul
RD /S /Q "C:\Windows\Temp\Gameforge4d"                     2>nul

if not "%GAME_DIR%"=="" (
  echo [*] Clearing game UserData + syserr under %GAME_DIR% ...
  RD /S /Q "%GAME_DIR%\UserData" 2>nul
  RD /S /Q "%GAME_DIR%\syserr"   2>nul
) else (
  echo [*] No GAME_DIR set - skipping game UserData/syserr wipe.
)

echo [*] Clearing Windows temp / prefetch / crash-report archive...
del /q /f /s "%LocalAppData%\Temp\*"                               >nul 2>&1
del /q /f /s "%TEMP%\*"                                            >nul 2>&1
del /q /f /s "C:\Windows\Prefetch\*"                               >nul 2>&1
RD  /S /Q    "C:\ProgramData\Microsoft\Windows\WER\ReportArchive"  2>nul

echo [*] Deleting GameForge fingerprint registry values...
REM  On current GF clients both HardwareId and InstallationId live under HKLM;
REM  delete from both hives so it works regardless of GF version.
reg delete "HKLM\SOFTWARE\WOW6432Node\Gameforge4d\GameforgeClient\MainApp" /v HardwareId     /f >nul 2>&1
reg delete "HKLM\SOFTWARE\WOW6432Node\Gameforge4d\GameforgeClient\MainApp" /v InstallationId /f >nul 2>&1
reg delete "HKCU\SOFTWARE\Gameforge4d\GameforgeClient\MainApp"             /v HardwareId     /f >nul 2>&1
reg delete "HKCU\SOFTWARE\Gameforge4d\GameforgeClient\MainApp"             /v InstallationId /f >nul 2>&1

echo.
echo [*] Verifying fingerprint values are gone (a cleared value prints nothing here):
reg query "HKLM\SOFTWARE\WOW6432Node\Gameforge4d\GameforgeClient\MainApp" /v HardwareId     2>&1 | findstr /C:"HardwareId"     && echo   [!] HKLM HardwareId STILL PRESENT
reg query "HKLM\SOFTWARE\WOW6432Node\Gameforge4d\GameforgeClient\MainApp" /v InstallationId 2>&1 | findstr /C:"InstallationId" && echo   [!] HKLM InstallationId STILL PRESENT
echo     (no [!] lines above = fingerprint registry values cleared)

echo.
echo [OK] Done. Start the GameForge client and log in again.
pause
