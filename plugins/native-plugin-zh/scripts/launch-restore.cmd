@echo off
setlocal

rem ASCII-only launcher: cmd.exe mis-parses non-ASCII text under DBCS codepages.
rem Locate a Node runtime, then run the self-contained restore server.

set "NODE_EXE="

if defined CODEX_MCP_NODE_PATH if exist "%CODEX_MCP_NODE_PATH%" set "NODE_EXE=%CODEX_MCP_NODE_PATH%"
if not defined NODE_EXE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE if defined LOCALAPPDATA for /d %%D in ("%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*") do if exist "%%~fD\bin\node.exe" set "NODE_EXE=%%~fD\bin\node.exe"
if not defined NODE_EXE if defined ProgramFiles for /d %%D in ("%ProgramFiles%\WindowsApps\OpenAI.Codex_*") do if exist "%%~fD\app\resources\cua_node\bin\node.exe" set "NODE_EXE=%%~fD\app\resources\cua_node\bin\node.exe"

if defined NODE_EXE goto run

where node >nul 2>&1
if errorlevel 1 goto missing
set "NODE_EXE=node"

:run
"%NODE_EXE%" "%~dp0restore-server.mjs"
exit /b %errorlevel%

:missing
echo native-plugin-zh restore: node runtime not found 1>&2
exit /b 127
