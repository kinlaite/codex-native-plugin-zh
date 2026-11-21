@echo off
setlocal

call "%~dp0launch_node.cmd" "%~dp0guard.mjs"
exit /b %errorlevel%
