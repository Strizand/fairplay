@echo off
cd /d "%~dp0"
title Сервис розыгрышей
where node >nul 2>nul
if errorlevel 1 goto nonode
echo Запускаю сервис розыгрышей...
echo Не закрывайте это окно, пока пользуетесь сервисом.
echo.
start "" "http://localhost:3000"
node server.js
echo.
echo Сервис остановлен. Если выше есть сообщение об ошибке - пришлите его разработчику.
pause
exit /b
:nonode
echo Node.js не найден. Установите его с https://nodejs.org (версия 22 или новее) и запустите этот файл снова.
pause
