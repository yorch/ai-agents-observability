set default-list
set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

prod_env := env_var_or_default("ENV_FILE", ".env.production")

# Create the local development env file without overwriting an existing one.
dev-init:
    @if [[ -e .env ]]; then echo ".env already exists"; else cp .env.example .env && echo "Created .env from .env.example"; fi

# Generate local development JWT signing keys.
dev-keys:
    @test -f .env || { echo "Missing .env; run 'just dev-init' first" >&2; exit 1; }
    bun run gen:keys

# Validate the local infrastructure Compose model.
dev-infra-config:
    @test -f .env || { echo "Missing .env; run 'just dev-init' first" >&2; exit 1; }
    docker compose --env-file .env -f docker-compose.infra.yml config --quiet

# Start only local backing services for native app development.
dev-infra-up:
    @test -f .env || { echo "Missing .env; run 'just dev-init' first" >&2; exit 1; }
    docker compose --env-file .env -f docker-compose.infra.yml up -d

# Stop local backing services while preserving data.
dev-infra-down:
    docker compose --env-file .env -f docker-compose.infra.yml down

# Follow local backing-service logs.
dev-infra-logs:
    docker compose --env-file .env -f docker-compose.infra.yml logs -f

# Validate the fully Dockerized development Compose model.
dev-config:
    @test -f .env || { echo "Missing .env; run 'just dev-init' first" >&2; exit 1; }
    docker compose --env-file .env -f docker-compose.infra.yml -f docker-compose.app.yml config --quiet

# Start the fully Dockerized development stack.
dev-up:
    @test -f .env || { echo "Missing .env; run 'just dev-init' first" >&2; exit 1; }
    docker compose --env-file .env -f docker-compose.infra.yml -f docker-compose.app.yml up -d --build

# Start Dockerized development with the GitHub App profile.
dev-pr-loop-up:
    @test -f .env || { echo "Missing .env; run 'just dev-init' first" >&2; exit 1; }
    docker compose --env-file .env -f docker-compose.infra.yml -f docker-compose.app.yml --profile pr-loop up -d --build

# Stop the fully Dockerized development stack while preserving data.
dev-down:
    docker compose --env-file .env -f docker-compose.infra.yml -f docker-compose.app.yml down

# Follow fully Dockerized development logs.
dev-logs:
    docker compose --env-file .env -f docker-compose.infra.yml -f docker-compose.app.yml logs -f

# Create the production env file without overwriting an existing one.
prod-init:
    @if [[ -e "{{ prod_env }}" ]]; then echo "{{ prod_env }} already exists"; else cp .env.production.example "{{ prod_env }}" && echo "Created {{ prod_env }} from .env.production.example"; fi

# Generate production JWT signing keys in ENV_FILE (default: .env.production).
prod-keys:
    @test -f "{{ prod_env }}" || { echo "Missing {{ prod_env }}; run 'just prod-init' first" >&2; exit 1; }
    bun run gen:keys -- --env-file="{{ prod_env }}"

# Validate the pre-built-image production Compose model.
prod-config:
    @test -f "{{ prod_env }}" || { echo "Missing {{ prod_env }}; run 'just prod-init' first" >&2; exit 1; }
    APP_ENV_FILE="{{ prod_env }}" docker compose --env-file "{{ prod_env }}" -f docker-compose.infra.yml -f docker-compose.prod.yml config --quiet

# Pull production application images.
prod-pull:
    @test -f "{{ prod_env }}" || { echo "Missing {{ prod_env }}; run 'just prod-init' first" >&2; exit 1; }
    APP_ENV_FILE="{{ prod_env }}" docker compose --env-file "{{ prod_env }}" -f docker-compose.infra.yml -f docker-compose.prod.yml pull

# Start production from pre-built images.
prod-up:
    @test -f "{{ prod_env }}" || { echo "Missing {{ prod_env }}; run 'just prod-init' first" >&2; exit 1; }
    APP_ENV_FILE="{{ prod_env }}" docker compose --env-file "{{ prod_env }}" -f docker-compose.infra.yml -f docker-compose.prod.yml up -d

# Start production by building application images from source.
prod-source-up:
    @test -f "{{ prod_env }}" || { echo "Missing {{ prod_env }}; run 'just prod-init' first" >&2; exit 1; }
    APP_ENV_FILE="{{ prod_env }}" docker compose --env-file "{{ prod_env }}" -f docker-compose.infra.yml -f docker-compose.prod.yml -f docker-compose.self-hosted.yml up -d --build

# Start pre-built production images behind an existing Traefik instance.
prod-traefik-up:
    @test -f "{{ prod_env }}" || { echo "Missing {{ prod_env }}; run 'just prod-init' first" >&2; exit 1; }
    APP_ENV_FILE="{{ prod_env }}" docker compose --env-file "{{ prod_env }}" -f docker-compose.infra.yml -f docker-compose.prod.yml -f docker-compose.traefik.yml up -d

# Start source-built production behind an existing Traefik instance.
prod-source-traefik-up:
    @test -f "{{ prod_env }}" || { echo "Missing {{ prod_env }}; run 'just prod-init' first" >&2; exit 1; }
    APP_ENV_FILE="{{ prod_env }}" docker compose --env-file "{{ prod_env }}" -f docker-compose.infra.yml -f docker-compose.prod.yml -f docker-compose.self-hosted.yml -f docker-compose.traefik.yml up -d --build

# Start production with automatic application-image updates.
prod-watchtower-up:
    @test -f "{{ prod_env }}" || { echo "Missing {{ prod_env }}; run 'just prod-init' first" >&2; exit 1; }
    APP_ENV_FILE="{{ prod_env }}" docker compose --env-file "{{ prod_env }}" -f docker-compose.infra.yml -f docker-compose.prod.yml -f docker-compose.watchtower.yml up -d

# Stop production while preserving data.
prod-down:
    APP_ENV_FILE="{{ prod_env }}" docker compose --env-file "{{ prod_env }}" -f docker-compose.infra.yml -f docker-compose.prod.yml down

# Show production service status.
prod-ps:
    APP_ENV_FILE="{{ prod_env }}" docker compose --env-file "{{ prod_env }}" -f docker-compose.infra.yml -f docker-compose.prod.yml ps

# Follow production logs.
prod-logs:
    APP_ENV_FILE="{{ prod_env }}" docker compose --env-file "{{ prod_env }}" -f docker-compose.infra.yml -f docker-compose.prod.yml logs -f
