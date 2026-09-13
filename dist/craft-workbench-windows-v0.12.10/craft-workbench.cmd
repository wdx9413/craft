@echo off
setlocal
"%~dp0node.exe" "%~dp0app\dist\src\cli.js" gui %*
