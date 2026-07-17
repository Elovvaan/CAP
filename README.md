# CAP Desktop

Creator Association Platform — local-first Windows desktop MVP.

## Included in v0.1

- Functional dashboard matching the approved CAP visual direction
- Working sidebar navigation
- Creator discovery queue
- Save creator state persisted locally with localStorage
- Creator circles, activity, collaboration progress
- Tauri 2 desktop shell configuration
- Windows installation helper that copies the project to `D:\CAP`

## Install on the D: drive

1. Extract the CAP folder.
2. Right-click `install-cap.ps1` and run with PowerShell.
3. Open PowerShell in `D:\CAP`.
4. Run `npm run dev` for the frontend preview.
5. Once Rust, Microsoft C++ Build Tools, and WebView2 are installed, run `npm run tauri dev`.

## Next build

Replace placeholder navigation workspaces with the Creator Directory and Creator Profile, then add SQLite persistence through the Tauri Rust backend.

## Railway Deployment

CAP runs as a Node server with SQLite-backed local platform data. Railway must provide a persistent volume for:

- `cap.db`
- uploaded profile and banner images in `uploads/`
- optional runtime logs

Set these Railway variables before the first hosted startup:

- `CAP_FOUNDER_EMAIL`
- `CAP_FOUNDER_PASSWORD`
- `CAP_DATA_DIR`
- `CAP_DB_PATH`
- `CAP_HOST=0.0.0.0`
- `PORT` (Railway normally sets this)
- `NODE_ENV=production`

Recommended Railway volume paths:

- `CAP_DATA_DIR=/data`
- `CAP_DB_PATH=/data/cap.db`

The first startup creates the founder/admin user only if no founder/admin user exists. `CAP_FOUNDER_PASSWORD` is used only for that first creation and is never applied again on later startups. After signing in, rotate the founder password from Account Settings and then remove or replace the one-time Railway password variable.

When an existing database is migrated for authentication, CAP writes a timestamped backup in the configured data directory:

`cap-pre-auth-YYYYMMDDHHMMSS.db`

Do not commit runtime databases, database backups, uploaded user media, logs, or `.env` files.
