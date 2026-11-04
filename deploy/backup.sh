#!/usr/bin/env bash
# Резервная копия базы и отчётов. Запускается ежедневно по расписанию (cron, ставит install.sh).
# Копии лежат в /var/backups/fairplay и хранятся KEEP_DAYS дней.
# ВАЖНО: копия на том же сервере не спасёт при потере сервера — настройте BACKUP_REMOTE
# (например, user@backup-host:/backups/fairplay) или регулярно скачивайте копии к себе.
set -euo pipefail

APP_DIR="${APP_DIR:-/home/fairplay/app}"
DEST="${DEST:-/var/backups/fairplay}"
KEEP_DAYS="${KEEP_DAYS:-14}"
BACKUP_REMOTE="${BACKUP_REMOTE:-}"

stamp="$(date +%Y-%m-%d_%H%M)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$DEST"
chmod 700 "$DEST"

# Согласованная копия SQLite «на ходу» (сервис останавливать не нужно)
sqlite3 "$APP_DIR/data/app.db" ".backup '$work/app.db'"
sqlite3 "$work/app.db" "PRAGMA integrity_check;" | grep -qx ok || { echo "Копия базы повреждена" >&2; exit 1; }

# Отчёты — неизменяемые JSON-файлы
tar -czf "$DEST/fairplay-$stamp.tar.gz" -C "$work" app.db -C "$APP_DIR/data" reports
chmod 600 "$DEST/fairplay-$stamp.tar.gz"

find "$DEST" -name 'fairplay-*.tar.gz' -mtime +"$KEEP_DAYS" -delete

if [ -n "$BACKUP_REMOTE" ]; then
  rsync -a "$DEST/fairplay-$stamp.tar.gz" "$BACKUP_REMOTE/"
fi

echo "Резервная копия: $DEST/fairplay-$stamp.tar.gz"
