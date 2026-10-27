@echo off
setlocal
call "%~dp0_env.cmd" || exit /b 1

where link >nul 2>&1 || (
  >&2 echo [glossnote] link.exe not found: MSVC toolchain is not on PATH
  exit /b 1
)
where cargo >nul 2>&1 || (
  >&2 echo [glossnote] cargo not found: check CARGO_HOME or the rustup installation
  exit /b 1
)

cargo --version
rustc --version
echo [glossnote] environment ready
exit /b 0
