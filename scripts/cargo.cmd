@echo off
setlocal
call "%~dp0_env.cmd" || exit /b 1
rem Allow running from anywhere in the repo: always switch to src-tauri first.
cd /d "%~dp0..\src-tauri"
cargo %*
