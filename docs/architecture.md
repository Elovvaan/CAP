# CAP v0.1 Architecture

- UI: React + TypeScript + Vite
- Desktop shell: Tauri 2
- Current persistence: browser localStorage for saved creators
- Planned persistence: SQLite via Rust backend commands
- Local-first design: profiles, circles, collaborations, and user preferences remain usable without a CAP cloud account
- External creator media: embedded players where providers allow embedding; official platform links for subscriptions, comments, likes, and follows
