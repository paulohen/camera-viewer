#!/usr/bin/env bash
# Prepara uma instalação nova (ou atualiza uma antiga): cria as pastas, o .env (com chaves aleatórias) e o config.json.
# Não sobrescreve nada que já exista, então é seguro rodar de novo. As câmeras NÃO são pedidas aqui: cadastre-as no painel (aba Câmeras).
# Uso: ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"

command -v docker >/dev/null || { echo "Docker não encontrado. Instale o Docker e o Docker Compose v2 primeiro."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "'docker compose' (v2) não encontrado."; exit 1; }
command -v python3 >/dev/null || { echo "python3 é necessário só para este script (editar o config.json)."; exit 1; }

rand() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# pastas que o Docker montaria como root se não existissem
mkdir -p faces faces_candidates cars gate waha_sessions cameras
chmod 700 cameras   # guarda as senhas das câmeras

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
  read -rp "Telefone que recebe os alertas, com DDI e DDD (ex.: +5511999999999), ou Enter para deixar em branco: " PHONE
  PHONE="$PHONE" KEY="$(grep '^WAHA_API_KEY=' .env | cut -d= -f2-)" python3 -I - <<'PY'
import json, os
cfg = json.load(open('config.example.json'))
cfg['alerts']['wahaApiKey'] = os.environ['KEY']
if os.environ['PHONE']:
    cfg['alerts']['whatsappPhone'] = os.environ['PHONE']
json.dump(cfg, open('config.json', 'w'), indent=2, ensure_ascii=False)
open('config.json', 'a').write('\n')
PY
  chmod 600 config.json
  echo "Criado config.json (contém a chave do WhatsApp: não publique)."
else
  echo "config.json já existe: mantido."
fi

cat <<'MSG'

Pronto. Próximos passos:
  1. docker compose up -d --build        (a primeira vez baixa alguns GB)
  2. Abra http://localhost:3000/dashboard e leia o QR code com o WhatsApp que vai ENVIAR os alertas
  3. ./set-password.sh                   (protege o painel com usuário e senha)
  4. Abra http://localhost:8090 (ou http://IP-DESTA-MAQUINA:8090) e cadastre as câmeras na aba "Câmeras"
     (IP, usuário, senha e um apelido para cada uma). Depois: rostos, portão e carros (veja o GUIA-INSTALACAO.md)
MSG
