#!/usr/bin/env sh
# Brings up the production stack (postgres + app + Caddy) on a Debian 13 server using
# compose.prod.yaml. Unlike docker-up.sh, this never builds the app image locally - it pulls
# the version pinned by IMAGE_TAG in .env.prod from ghcr.io, published by
# .github/workflows/release-image.yml on every version tag.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

COMPOSE_FILE=compose.prod.yaml
ENV_FILE=.env.prod
WAIT_TIMEOUT_SECONDS=${WAIT_TIMEOUT_SECONDS:-240}

compose() {
    docker compose --file "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    printf '%s\n' 'Docker Compose v2 was not found. Install Docker Engine + the Compose v2 plugin first:' \
        '  https://docs.docker.com/engine/install/debian/' >&2
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    printf '%s\n' 'Docker is installed, but its engine is not reachable.' \
        'Start it with `sudo systemctl start docker`, then retry.' \
        'If the error says permission denied, add your user to the docker group and start a new login session.' >&2
    exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
    cp .env.prod.example "$ENV_FILE"
    printf '%s\n' "Created $ENV_FILE from .env.prod.example. Fill in every replace-with-* value (image tag, domain, secrets, signing key path), then run this script again." >&2
    exit 1
fi

# Compose gives already-exported shell/session env vars precedence over --env-file, so a stray
# `export IMAGE_TAG=...` (or any other var also set in .env.prod) left over in this shell would
# silently shadow the value in the file. Unset every variable name that .env.prod defines (not
# its value - .env.prod isn't valid shell syntax, e.g. unquoted spaces in string values) so
# nothing can shadow it and --env-file is always the source of truth.
for _var_name in $(sed -n 's/^[[:space:]]*\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*=.*/\1/p' "$ENV_FILE"); do
    unset "$_var_name"
done

# LICENSE_SIGNING_KEY_DIR is read directly out of the env file here (rather than left to Compose)
# so a missing key directory fails before any container starts, with a clear message.
KEY_DIR=$(sed -n 's/^[[:space:]]*LICENSE_SIGNING_KEY_DIR[[:space:]]*=[[:space:]]*\([^#[:space:]]*\).*/\1/p' "$ENV_FILE" | tail -n 1)
if [ -z "$KEY_DIR" ] || [ ! -d "$KEY_DIR" ]; then
    printf '%s\n' "LICENSE_SIGNING_KEY_DIR ('$KEY_DIR') does not exist. Create it and populate it with your production signing key pair before starting." >&2
    exit 1
fi

compose config --quiet

if ! compose pull; then
    printf '%s\n' 'Pulling images failed. If ghcr.io/.../license-server-app is private, log in first:' \
        '  echo "$GITHUB_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin' \
        '(a classic PAT with read:packages is enough), then retry.' >&2
    exit 1
fi

if ! compose up --detach --no-build --wait --wait-timeout "$WAIT_TIMEOUT_SECONDS"; then
    compose ps || true
    compose logs --tail 80 app postgres caddy >&2 || true
    exit 1
fi

compose ps
DOMAIN=$(sed -n 's/^[[:space:]]*CADDY_DOMAIN[[:space:]]*=[[:space:]]*\([^#[:space:]]*\).*/\1/p' "$ENV_FILE" | tail -n 1)
printf '\nLicenseServer is healthy: https://%s\n' "${DOMAIN:-<CADDY_DOMAIN>}"
