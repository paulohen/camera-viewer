#!/usr/bin/env bash
# Define (ou troca) o usuário e a senha do painel. A senha é pedida sem aparecer na tela e só o hash vai para o config.json.
set -euo pipefail
cd "$(dirname "$0")"
read -rp "Usuário: " user
read -rsp "Senha (mínimo 8 caracteres): " pw; echo
read -rsp "Repita a senha: " pw2; echo
[ "$pw" = "$pw2" ] || { echo "As senhas não conferem."; exit 1; }
if command -v node >/dev/null 2>&1; then
  printf '%s' "$pw" | node tools/set-password.js "$user"
else
  printf '%s' "$pw" | docker run --rm -i --user "$(id -u):$(id -g)" -v "$PWD:/w" -w /w node:22-alpine node tools/set-password.js "$user"
fi
docker compose restart camera-viewer
echo "Pronto. Abra o painel e entre com o novo usuário e senha."
