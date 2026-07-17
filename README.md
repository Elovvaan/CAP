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
