#!/usr/bin/env bash
# deploy.sh — zero-interruption deployment for tumasend-gw
#
# Strategy:
#   1. Stash local changes so git operations are clean
#   2. Pull & rebase remote commits
#   3. Detect which services actually changed (avoids unnecessary rebuilds)
#   4. Pre-build new images while old containers are still serving traffic
#   5. Hot-swap containers — Docker Compose restart is a matter of seconds
#   6. Restore stashed work
#
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh            # normal deploy
#   ./deploy.sh --no-stash # skip stash (e.g. repo is clean on CI)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[deploy]${NC} $*"; }
success() { echo -e "${GREEN}[deploy]${NC} $*"; }
warn()    { echo -e "${YELLOW}[deploy]${NC} $*"; }
die()     { echo -e "${RED}[deploy] ERROR:${NC} $*" >&2; exit 1; }

# ── Guards ────────────────────────────────────────────────────────────────────
command -v git           >/dev/null 2>&1 || die "git not found"
command -v docker        >/dev/null 2>&1 || die "docker not found"
command -v docker compose >/dev/null 2>&1 || die "docker compose not found (requires Docker Compose v2)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

[[ -f .env ]] || die ".env not found. Copy .env.example and fill in secrets before deploying."

NO_STASH=false
[[ "${1:-}" == "--no-stash" ]] && NO_STASH=true

# ── Step 1: Stash local changes ───────────────────────────────────────────────
STASHED=false
if [[ "$NO_STASH" == false ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    info "Stashing local changes..."
    git stash push -m "deploy-$(date +%Y%m%d-%H%M%S)"
    STASHED=true
  else
    info "Working tree is clean — nothing to stash."
  fi
fi

# Restore stash on any subsequent error so work is never lost
restore_stash() {
  if [[ "$STASHED" == true ]]; then
    warn "Restoring stashed changes after error..."
    git stash pop || warn "Could not pop stash automatically. Run: git stash pop"
  fi
}
trap restore_stash ERR

# ── Step 2: Pull & rebase ─────────────────────────────────────────────────────
info "Fetching remote changes..."
git fetch --prune origin

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "@{u}" 2>/dev/null || echo "")

if [[ -z "$REMOTE" ]]; then
  warn "No upstream branch configured — skipping pull."
elif [[ "$LOCAL" == "$REMOTE" ]]; then
  info "Already up to date."
else
  info "Rebasing onto $(git rev-parse --abbrev-ref HEAD)..."
  git rebase origin/"$(git rev-parse --abbrev-ref HEAD)"
  success "Rebase complete."
fi

# ── Step 3: Detect what changed since last deploy ─────────────────────────────
# Compare HEAD with the previously deployed commit (stored in .last-deploy)
LAST_DEPLOY_FILE=".last-deploy"
PREV_COMMIT=$(cat "$LAST_DEPLOY_FILE" 2>/dev/null || echo "")
CURRENT_COMMIT=$(git rev-parse HEAD)

rebuild_gateway=true
rebuild_kannel=false

if [[ -n "$PREV_COMMIT" ]] && git cat-file -e "$PREV_COMMIT^{commit}" 2>/dev/null; then
  CHANGED=$(git diff --name-only "$PREV_COMMIT" "$CURRENT_COMMIT")

  # Gateway needs a rebuild if app source, dependencies, or its Dockerfile changed
  if echo "$CHANGED" | grep -qE '^(src/|Dockerfile|package(-lock)?\.json|\.dockerignore)'; then
    info "Gateway source changed — will rebuild."
    rebuild_gateway=true
  else
    info "No gateway source changes detected — skipping rebuild."
    rebuild_gateway=false
  fi

  # Kannel only needs a rebuild if its own directory or config changed
  if echo "$CHANGED" | grep -qE '^kannel/'; then
    info "Kannel config changed — will rebuild."
    rebuild_kannel=true
  fi
else
  warn "No previous deploy marker found — performing full build."
fi

# ── Step 4: Pre-build new images (old containers keep serving while this runs) ─
COMPOSE_ARGS="--file docker-compose.yml"

if [[ "$rebuild_gateway" == true && "$rebuild_kannel" == true ]]; then
  info "Building gateway + kannel images..."
  docker compose $COMPOSE_ARGS build --pull gateway kannel

elif [[ "$rebuild_gateway" == true ]]; then
  info "Building gateway image..."
  docker compose $COMPOSE_ARGS build --pull gateway

elif [[ "$rebuild_kannel" == true ]]; then
  info "Building kannel image..."
  docker compose $COMPOSE_ARGS build --pull kannel

else
  info "No image rebuilds needed."
fi

# ── Step 5: Hot-swap containers ───────────────────────────────────────────────
# `up -d` compares the desired state with running containers and only restarts
# services whose image or config changed — leaving untouched services running.
info "Applying new containers..."
docker compose $COMPOSE_ARGS up -d --remove-orphans

# Brief health wait — give the gateway a moment to bind its port
info "Waiting for gateway to become healthy..."
MAX_WAIT=30
WAITED=0
until docker compose $COMPOSE_ARGS exec -T gateway node -e "
  const http = require('http');
  http.get('http://localhost:3000/', r => process.exit(r.statusCode < 500 ? 0 : 1))
      .on('error', () => process.exit(1));
" 2>/dev/null; do
  sleep 2
  WAITED=$((WAITED + 2))
  if [[ $WAITED -ge $MAX_WAIT ]]; then
    die "Gateway did not become healthy within ${MAX_WAIT}s. Check: docker compose logs gateway"
  fi
  info "  still waiting... (${WAITED}s)"
done

success "Gateway is healthy."

# ── Step 6: Record deployed commit ───────────────────────────────────────────
echo "$CURRENT_COMMIT" > "$LAST_DEPLOY_FILE"

# ── Step 7: Restore stash ────────────────────────────────────────────────────
trap - ERR  # clear error trap — stash pop is not needed on success path
if [[ "$STASHED" == true ]]; then
  info "Restoring stashed local changes..."
  git stash pop
fi

# ── Done ──────────────────────────────────────────────────────────────────────
success "Deploy complete. Commit: ${CURRENT_COMMIT:0:7}"
info  "  Logs:   docker compose logs -f"
info  "  Status: docker compose ps"
