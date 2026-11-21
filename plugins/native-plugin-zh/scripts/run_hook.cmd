@echo off
setlocal

call "%~dp0launch_mcp.cmd" "%~dp0hook.mjs" %*
exit /b %errorlevel%
