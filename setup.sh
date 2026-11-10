#!/usr/bin/env bash
# Prepara uma instalação nova: cria as pastas, o .env (com chaves aleatórias) e o config.json. Não sobrescreve nada que já exista.
# Uso: ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"

command -v docker >/dev/null || { echo "Docker não encontrado. Instale o Docker e o Docker Compose v2 primeiro."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "'docker compose' (v2) não encontrado."; exit 1; }
command -v python3 >/dev/null || { echo "python3 é necessário só para este script (editar o config.json)."; exit 1; }

rand() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# pastas que o Docker montaria como root se não existissem
mkdir -p faces faces_candidates cars/_capturas gate/refs waha_sessions

if [ ! -f .env ]; then
  KEY=$(rand)
  cp .env.example .env
  sed -i \
    -e "s|^WAHA_API_KEY=.*|WAHA_API_KEY=$KEY|" \
    -e "s|^WAHA_DASHBOARD_PASSWORD=.*|WAHA_DASHBOARD_PASSWORD=$(rand)|" \
    -e "s|^WHATSAPP_SWAGGER_PASSWORD=.*|WHATSAPP_SWAGGER_PASSWORD=$(rand)|" \
    -e "s|^UID_GID=.*|UID_GID=$(id -u):$(id -g)|" \
    -e "s|^CAMERA_IMAGES_DIR=.*|CAMERA_IMAGES_DIR=\"$PWD/cameraImages\"|" .env
  mkdir -p cameraImages
  chmod 600 .env
  echo "Criado .env com chaves aleatórias (fotos em $PWD/cameraImages; edite CAMERA_IMAGES_DIR para usar outro disco)."
else
  echo ".env já existe: mantido."
fi

if [ ! -f config.json ]; then
  read -rp "URL RTSP da câmera (ex.: rtsp://usuario:senha@192.168.0.10:554/cam/realmonitor?channel=1&subtype=1): " RTSP
  read -rp "Telefone que recebe os alertas, com DDI e DDD (ex.: +5511999999999), ou Enter para deixar em branco: " PHONE
  RTSP="$RTSP" PHONE="$PHONE" KEY="$(grep '^WAHA_API_KEY=' .env | cut -d= -f2-)" python3 -I - <<'PY'
import json, os
cfg = json.load(open('config.example.json'))
if os.environ['RTSP']:
    cfg['rtspUrl'] = os.environ['RTSP']
cfg['alerts']['wahaApiKey'] = os.environ['KEY']
if os.environ['PHONE']:
    cfg['alerts']['whatsappPhone'] = os.environ['PHONE']
json.dump(cfg, open('config.json', 'w'), indent=2, ensure_ascii=False)
open('config.json', 'a').write('\n')
PY
  chmod 600 config.json
  echo "Criado config.json (contém a senha da câmera: não publique)."
else
  echo "config.json já existe: mantido."
fi

cat <<'MSG'

Pronto. Próximos passos:
  1. docker compose up -d --build        (a primeira vez baixa alguns GB)
  2. Abra http://localhost:3000/dashboard e leia o QR code com o WhatsApp que vai ENVIAR os alertas
  3. ./set-password.sh                   (protege o painel com usuário e senha)
  4. Abra http://localhost:8090 e siga a seção 4.2 do README (rostos, portão, carros)
MSG
