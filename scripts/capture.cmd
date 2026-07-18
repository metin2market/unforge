@echo off
rem One command: proxy on -> capture -> proxy off (on Ctrl+C). See capture.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0capture.ps1"
