#!/usr/bin/env bash
# Обновление сервиса до последней версии из GitHub.
# Запуск на сервере:  sudo bash /home/fairplay/app/deploy/update.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/home/fairplay/app}"
[ "$(id -u)" -eq 0 ] || { echo "Запустите через sudo"; exit 1; }

echo "→ Резервная копия перед обновлением"
bash "$APP_DIR/deploy/backup.sh"

echo "→ Загружаю новую версию"
sudo -u fairplay git -C "$APP_DIR" pull --ff-only

# Служба могла измениться вместе с кодом
install -m 644 "$APP_DIR/deploy/fairplay.service" /etc/systemd/system/fairplay.service
systemctl daemon-reload

echo "→ Перезапускаю сервис"
systemctl restart fairplay

for i in $(seq 1 15); do
  if curl -fsS http://127.0.0.1:3000/api/status >/dev/null 2>&1; then
    echo "✓ Сервис работает: $(sudo -u fairplay git -C "$APP_DIR" log -1 --format='%h %s')"
    exit 0
  fi
  sleep 1
done
echo "✗ Сервис не отвечает. Журнал: journalctl -u fairplay -n 50" >&2
exit 1
