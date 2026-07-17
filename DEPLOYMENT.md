# CAP Deployment Guide

CAP is a local-first creator platform that can also run as a web service on Railway. The desktop launcher is preserved: double-clicking `launch-cap.vbs` still starts the local app on `127.0.0.1:1420` and uses `D:\CAP-desktop-v0.1\CAP\data` by default.

## What is safe to commit

The repository should include the application source, current built web assets in `dist`, the Node server, launcher scripts, and deployment config. It must not include local data or personal files:

- `data/cap.db`, `data/cap.db-wal`, `data/cap.db-shm`
- `data/uploads/*`
- `cap-launch.log` or other logs
- `node_modules/`
- `.env` files

These are excluded by `.gitignore`.

## Railway deployment

Railway should run:

```bash
npm start
```

The server reads Railway's `PORT` automatically and binds to `0.0.0.0` when hosted. The health endpoint is:

```text
/health
```

## Required Railway persistent storage

Add a Railway volume and mount it at:

```text
/data
```

Then set:

```text
CAP_DATA_DIR=/data
CAP_NO_OPEN=1
```

Railway sets `PORT` automatically. `CAP_DB_PATH` is optional; if unset, CAP uses `${CAP_DATA_DIR}/cap.db`. Uploaded images are stored in `${CAP_DATA_DIR}/uploads` and database image references remain compatible with local CAP media paths.

## Local desktop behavior

No environment variables are required locally. Defaults remain:

```text
Host: 127.0.0.1
Port: 1420
Database: ./data/cap.db
Uploads: ./data/uploads
Log: ./cap-launch.log
```

Use the desktop shortcut or run:

```bash
npm start
```

## GitHub/Railway notes

This app intentionally commits `dist` so Railway serves the same approved UI as the current desktop build without needing to rebuild the frontend during deployment.
