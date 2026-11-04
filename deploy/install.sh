#!/usr/bin/env bash
# Первичная установка ЧестногоРозыгрыша на чистый сервер Ubuntu 22.04 / 24.04.
#
#   curl -fsSLO https://raw.githubusercontent.com/Strizand/fairplay/main/deploy/install.sh   (если репозиторий публичный)
#   или скопируйте этот файл на сервер, затем:
#   sudo bash install.sh rozygrysh.ru admin@rozygrysh.ru
#
# Что делает: ставит Node.js 22, Git, Caddy, SQLite и файрвол; создаёт пользователя fairplay;
# скачивает код из GitHub по ключу развёртывания (deploy key); создаёт .env; запускает службу;
# настраивает HTTPS и ежедневные резервные копии. Повторный запуск безопасен.
set -euo pipefail

DOMAIN="${1:-}"
ADMIN_EMAIL="${2:-}"
REPO="${REPO:-git@github.com:Strizand/fairplay.git}"
APP_USER=fairplay
APP_DIR="/home/$APP_USER/app"

if [ "$(id -u)" -ne 0 ]; then echo "Запустите через sudo: sudo bash install.sh <домен> <e-mail администратора>"; exit 1; fi
if [ -z "$DOMAIN" ] || [ -z "$ADMIN_EMAIL" ]; then
  echo "Использование: sudo bash install.sh rozygrysh.ru admin@rozygrysh.ru"; exit 1
fi
if ! [[ "$DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]]; then echo "Домен без https:// и без слеша, например rozygrysh.ru"; exit 1; fi
if ! [[ "$ADMIN_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then echo "Неверный e-mail администратора"; exit 1; fi

step() { echo; echo "━━ $* ━━"; }

step "1/8 Системные пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q curl git sqlite3 ufw ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https rsync

step "2/8 Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
node --version

step "3/8 Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

step "4/8 Пользователь $APP_USER и доступ к репозиторию"
id "$APP_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$APP_USER"
KEY="/home/$APP_USER/.ssh/id_ed25519"
if [ ! -f "$KEY" ]; then
  sudo -u "$APP_USER" mkdir -p "/home/$APP_USER/.ssh"
  sudo -u "$APP_USER" ssh-keygen -q -t ed25519 -N '' -C "fairplay-deploy@$DOMAIN" -f "$KEY"
fi
sudo -u "$APP_USER" bash -c "ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null; sort -u -o ~/.ssh/known_hosts ~/.ssh/known_hosts"

if [ ! -d "$APP_DIR/.git" ]; then
  echo
  echo "Добавьте этот ключ в GitHub: репозиторий → Settings → Deploy keys → Add deploy key"
  echo "(галочку «Allow write access» НЕ ставьте — серверу нужно только чтение):"
  echo
  cat "$KEY.pub"
  echo
  read -r -p "Когда добавите ключ, нажмите Enter… " _
  sudo -u "$APP_USER" git clone "$REPO" "$APP_DIR"
fi
sudo -u "$APP_USER" mkdir -p "$APP_DIR/data"
chmod 750 "/home/$APP_USER" "$APP_DIR/data"

step "5/8 Настройки (.env)"
ENV="$APP_DIR/.env"
if [ ! -f "$ENV" ]; then
  sudo -u "$APP_USER" cp "$APP_DIR/.env.example" "$ENV"
  set_env() { sed -i "s|^$1=.*|$1=$2|" "$ENV"; grep -q "^$1=" "$ENV" || echo "$1=$2" >> "$ENV"; }
  set_env NODE_ENV production
  set_env HOST 127.0.0.1
  set_env PUBLIC_URL "https://$DOMAIN"
  set_env ADMIN_EMAILS "$ADMIN_EMAIL"
  set_env COOKIE_SECURE 1
  set_env TRUST_PROXY 1
  echo "Создан $ENV. Ключи VK, ЮKassa и почту удобнее задать потом в админке: https://$DOMAIN/admin.html"
else
  echo "$ENV уже есть — не трогаю."
fi
chown "$APP_USER:$APP_USER" "$ENV"
chmod 600 "$ENV"

step "6/8 Служба fairplay"
install -m 644 "$APP_DIR/deploy/fairplay.service" /etc/systemd/system/fairplay.service
systemctl daemon-reload
systemctl enable fairplay >/dev/null
systemctl restart fairplay

step "7/8 HTTPS для $DOMAIN и файрвол"
sed "s/example\.ru/$DOMAIN/g" "$APP_DIR/deploy/Caddyfile.example" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy || systemctl restart caddy
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | sed -n '1,8p'

step "8/8 Ежедневная резервная копия (03:30)"
cat > /etc/cron.d/fairplay-backup <<EOF
# Резервная копия ЧестногоРозыгрыша. Чтобы копировать на другой сервер, добавьте BACKUP_REMOTE=user@host:/path
30 3 * * * root bash $APP_DIR/deploy/backup.sh >> /var/log/fairplay-backup.log 2>&1
EOF
chmod 644 /etc/cron.d/fairplay-backup

echo
for i in $(seq 1 15); do
  curl -fsS http://127.0.0.1:3000/api/status >/dev/null 2>&1 && break
  sleep 1
done
if curl -fsS http://127.0.0.1:3000/api/status >/dev/null 2>&1; then
  echo "✓ Готово. Откройте https://$DOMAIN (сертификат выпускается в первые 1–2 минуты)."
  echo "  1. Зарегистрируйтесь с адресом $ADMIN_EMAIL — это администратор."
  echo "  2. В https://$DOMAIN/admin.html → Настройки заполните реквизиты продавца, ключ VK, почту и ЮKassa."
  echo "  Обновление:  sudo bash $APP_DIR/deploy/update.sh      Журнал:  journalctl -u fairplay -f"
else
  echo "✗ Сервис не ответил. Посмотрите журнал: journalctl -u fairplay -n 50" >&2
  exit 1
fi
