@echo off
setlocal
call "%~dp0_env.cmd" || exit /b 1
cd /d "%~dp0.."
rem Call the local CLI directly: npm run would rebuild PATH and drop CARGO_HOME.
call node_modules\.bin\tauri.cmd build
