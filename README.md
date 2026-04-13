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

### 2) Build and run (LAN/direct access)

```bash
docker compose up -d --build
```

### 3) Access app

- URL: `http://<your-server-ip>:8080` (or custom `WEB_PORT`)
- API is routed internally via Nginx as `/api`

Note: for secure defaults, `WEB_BIND_IP` is set to `127.0.0.1` in `.env.example`.
If you want direct LAN access (without Cloudflare Tunnel), set:

```env
WEB_BIND_IP=0.0.0.0
```

### 4) Cloudflare Tunnel (recommended for internet exposure)

1. Create a Cloudflare Tunnel and copy the tunnel token.
2. Set `CF_TUNNEL_TOKEN` in `.env`.
3. Keep `WEB_BIND_IP=127.0.0.1` so the app is not directly exposed on LAN.
4. Start with Cloudflare profile enabled:

```bash
docker compose --profile cloudflare up -d --build
```

Then access via your Cloudflare hostname (HTTPS), and protect it with Cloudflare Access policies (recommended).

### 5) Cloudflare Access policy (Google login, single-user lock)

To ensure only you can open the app, put your tunnel hostname behind Cloudflare Access.

1. In Cloudflare Zero Trust, go to **Settings -> Authentication -> Login methods**.
2. Add **Google** as an identity provider.
3. Configure your Google OAuth app (or use Cloudflare's guided setup) and save.
4. Go to **Access -> Applications -> Add an application**.
5. Choose **Self-hosted** and set:
   - **Application domain**: your tunnel hostname (for example `drink.example.com`)
   - **Session duration**: your preference (for example `24h` or `7d`)
6. Add an **Allow** policy:
   - **Include**: `Emails` -> `your-google-address@gmail.com`
7. (Recommended) Add a stricter rule:
   - Require **MFA** in Access policy controls.
8. Save and deploy.

Result: users must sign in with Google, and only the allowed email can reach HydrateMe.

Tip: keep `WEB_BIND_IP=127.0.0.1` so the app is only reachable through Tunnel/Access, not directly from LAN.

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
