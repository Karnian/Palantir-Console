#!/usr/bin/env bash
set -euo pipefail

# Palantir Console — 격리 환경 자동 설정 스크립트
# Usage: bash setup.sh

REQUIRED_NODE_MAJOR=20
PORT="${PORT:-4177}"

echo "=== Palantir Console Setup ==="

# 1. Node.js 버전 확인
check_node() {
  if command -v node &>/dev/null; then
    local ver
    ver=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$ver" -ge "$REQUIRED_NODE_MAJOR" ]; then
      echo "[ok] Node.js $(node -v) detected"
      return 0
    fi
  fi
  return 1
}

# 2. nvm으로 Node 설치 (없으면)
ensure_node() {
  if check_node; then return 0; fi

  echo "[info] Node.js $REQUIRED_NODE_MAJOR+ not found."

  # nvm이 있으면 사용
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    echo "[info] Loading nvm..."
    # shellcheck source=/dev/null
    . "$HOME/.nvm/nvm.sh"
    nvm install "$REQUIRED_NODE_MAJOR" && nvm use "$REQUIRED_NODE_MAJOR"
    if check_node; then return 0; fi
  fi

  # volta가 있으면 사용
  if command -v volta &>/dev/null; then
    echo "[info] Using volta..."
    volta install "node@$REQUIRED_NODE_MAJOR"
    if check_node; then return 0; fi
  fi

  # fnm이 있으면 사용
  if command -v fnm &>/dev/null; then
    echo "[info] Using fnm..."
    fnm install "$REQUIRED_NODE_MAJOR" && fnm use "$REQUIRED_NODE_MAJOR"
    if check_node; then return 0; fi
  fi

  echo "[error] Node.js $REQUIRED_NODE_MAJOR+ required. Install via:"
  echo "  brew install node@$REQUIRED_NODE_MAJOR"
  echo "  or: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash"
  exit 1
}

# 3. 의존성 설치
install_deps() {
  if [ -d node_modules ] && [ -f node_modules/.package-lock.json ]; then
    echo "[ok] Dependencies already installed"
  else
    echo "[info] Installing dependencies..."
    npm ci --omit=dev 2>/dev/null || npm install --omit=dev
    echo "[ok] Dependencies installed"
  fi
}

# 4. 환경 파일
setup_env() {
  if [ ! -f .env ]; then
    if [ -f .env.example ]; then
      cp .env.example .env
      echo "[ok] Created .env from .env.example"
    fi
  else
    echo "[ok] .env already exists"
  fi
}

# 5. 실행
main() {
  ensure_node
  install_deps
  setup_env

  echo ""
  echo "=== Setup Complete ==="
  echo ""
  echo "Start server:"
  echo "  npm start"
  echo ""
  echo "Or with Docker:"
  echo "  docker compose up --build"
  echo ""
  echo "Open: http://localhost:$PORT"
}

main "$@"
