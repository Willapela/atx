#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 ou superior é necessário. Instale-o e execute novamente."
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 18 ou superior é necessário. Versão encontrada: $(node --version)"
  exit 1
fi

npm ci --omit=dev --no-audit --no-fund
mkdir -p data/users

if [ -z "${JWT_SECRET:-}" ]; then
  echo "AVISO: JWT_SECRET não foi definido. Defina-o antes de colocar o painel na internet."
fi

echo "Instalação concluída. Inicie com:"
echo "  JWT_SECRET='sua-chave-secreta' node index.js"
echo "Depois acesse: http://IP_DA_VPS:2000/register"
