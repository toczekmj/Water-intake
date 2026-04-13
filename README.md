# HydrateMe

HydrateMe is a mobile-first PWA for tracking daily fluid intake (water, coffee, tea, custom fluids) with:

- hydration scoring (hydration factors per fluid + caffeine penalty profile)
- optional keto electrolyte tracking (sodium, potassium, magnesium)
- configurable cup sizes (for example 250ml, 300ml)
- offline intake logging and background sync
- interactive stats (history chart + 7/30/90/180 day ranges + fluid composition)
- first-run guided app tour + manual retake from Settings
- light/dark/system appearance modes with persistence
- Docker deployment for Proxmox/self-hosted environments

## Stack

- `apps/web`: React + Vite PWA frontend
- `apps/api`: Fastify + PostgreSQL backend
- `docker-compose.yml`: web + api + db runtime

## Local Development

### 1) Prepare env

```bash
cp .env.example .env
```

### 2) Install deps

```bash
npm install
```

### 3) Start PostgreSQL (Docker)

```bash
docker compose up -d db
```

### 4) Run API and web

```bash
DATABASE_URL=postgresql://hydrateme:change-this-db-password@localhost:5432/hydrateme APP_TOKEN=change-this-app-token npm run dev -w apps/api
```

In another terminal:

```bash
VITE_API_URL=http://localhost:4000/api VITE_APP_TOKEN=change-this-app-token npm run dev -w apps/web
```

Open [http://localhost:5173](http://localhost:5173).

## Docker Deployment (Proxmox-ready)

### 1) Copy env

```bash
cp .env.example .env
```

Edit `.env` with strong `POSTGRES_PASSWORD` and `APP_TOKEN`.

### 2) Build and run

```bash
docker compose up -d --build
```

### 3) Access app

- URL: `http://<your-server-ip>:8080` (or custom `WEB_PORT`)
- API is routed internally via Nginx as `/api`

## iPhone Install

1. Open app URL in Safari.
2. Tap Share -> Add to Home Screen.
3. Launch from home screen (standalone PWA mode).

Note: iPhone PWA install requires HTTPS in production (or local/dev exceptions). Use a reverse proxy with TLS (for example Nginx Proxy Manager, Caddy, Traefik).

## Data Model (high level)

- `fluids`: fluid types per user
- `cup_presets`: custom cup volumes
- `intake_entries`: logged events with fluid, ml, hydration credit, caffeine/electrolyte values, timestamp
- `settings`: daily goal, hydration mode, caffeine habituation, electrolyte options

## API Auth

API uses a bearer token (`APP_TOKEN`) for personal self-hosted usage.
Frontend sends the same token via `VITE_APP_TOKEN`.

## Offline Behavior

- Intakes created offline are queued in IndexedDB.
- Queue flushes automatically when connection returns.
- Cached data is shown if API is unavailable.

## Backup Strategy

Use periodic PostgreSQL dumps from the `db` container:

```bash
docker compose exec -T db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > hydrateme_backup.sql
```

Restore:

```bash
cat hydrateme_backup.sql | docker compose exec -T db psql -U "$POSTGRES_USER" "$POSTGRES_DB"
```
