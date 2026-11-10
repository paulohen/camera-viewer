#!/usr/bin/env bash
# Backup de tudo que NÃO está no código: configuração, segredos, rostos cadastrados, calibração do portão e a sessão do WhatsApp.
# As fotos de ocorrências (CAMERA_IMAGES_DIR) ficam de fora; copie essa pasta à parte se quiser.
# Uso: ./backup.sh [pasta-de-destino]    (padrão: ./backups)
set -euo pipefail
cd "$(dirname "$0")"
dest="${1:-./backups}"
mkdir -p "$dest"
out="$dest/camera-backup-$(date +%Y-%m-%d_%H%M).tar.gz"
umask 077
tar -czf "$out" \
  --exclude='gate/latest.jpg' --exclude='gate/*.tmp*' \
  config.json .env faces faces_candidates cars gate waha_sessions
chmod 600 "$out"
echo "Backup criado: $out ($(du -h "$out" | cut -f1))"
echo "ATENÇÃO: contém senhas e a sessão do WhatsApp. Guarde em local seguro e nunca publique."
