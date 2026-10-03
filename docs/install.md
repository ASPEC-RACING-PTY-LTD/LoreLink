# Install LoreLink

## Docker Compose

From the repository root:

```bash
docker compose up --build
```

Open the printed public URL (default `http://127.0.0.1:8080`) and complete setup.

Persistent volumes:

- `pgdata`: PostgreSQL
- `lorelink_data`: instance key and rebuildable caches

## Environment

Only these variables are required for a first run:

- `LORELINK_DATABASE_URL` (set by Compose)
- `LORELINK_DATA_DIR` (set by Compose)
- `LORELINK_HTTP_ADDR` (set by Compose)
- `LORELINK_PUBLIC_URL` (optional; also collected during setup)

## Reverse proxies and Cloudflare Tunnel

Bind LoreLink to `127.0.0.1` and terminate TLS at the proxy. Set `LORELINK_PUBLIC_URL` to the external origin. Trusted proxy handling will be expanded when host-based publishing lands.

## Backup

Dump PostgreSQL and copy `$LORELINK_DATA_DIR/instance.key`. Git remotes remain the backup for documentation content.
