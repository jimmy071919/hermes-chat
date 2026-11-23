# Hermes Chat

A ChatGPT-style web chat for the local Hermes Agent, built on the Hermes API server (`API_SERVER_*` in `~/.hermes/.env`).

- Text chat with streaming replies, Markdown, and code highlighting. Tool calls and the thinking process show as collapsible sections.
- Attach files and images: click the paperclip, drag and drop, or paste with Ctrl+V. Images go to the model directly; every attachment is also saved under `data/workspace/<session>/uploads/`, and Hermes is told the absolute path so it can read the file with its tools.
- File downloads: Hermes is asked to save output files to `data/workspace/<session>/outputs/`.
  - The folder icon at the top right lists every file in the current chat for download.
  - Absolute paths that appear in a reply automatically become download links.
- Model switching: the model menu at the top lists every model from the providers Hermes is signed in to (Anthropic, ChatGPT subscription, OpenAI API…), with search and a reasoning-effort choice (auto/low/medium/high). A chosen model is locked to that chat (Hermes `require_model_lock`) and stays after reopening. New chats start with your last choice; "Hermes 預設" uses the global model from `config.yaml`.
- MCP and Skills management (「MCP 與 Skills 管理」 at the bottom left):
  - MCP: list, enable/disable, test connection (shows the tool list), OAuth login, add HTTP/stdio servers, delete, install from the Nous catalog, and restart the gateway to apply changes.
  - Skills: list installed skills (search, filter, enable/disable), view/edit SKILL.md, search and install from the hub (preview and security scan first), check for updates, uninstall, and create new skills.
  - How it works: requests go through `/api/admin/*` to the Hermes dashboard's REST API (port 9119), restricted to a whitelist of routes. Authentication uses the deployment token `~/.hermes/dashboard-session-token`. The dashboard runs as `systemctl --user hermes-dashboard.service` and reads that token via `HERMES_DASHBOARD_SESSION_TOKEN=file:...`.
- The chat list on the left is the same as Hermes's sessions. You can rename and delete chats, and tick a box to also show CLI, Telegram and other sources.
- When Hermes needs approval to run a command, an approval card appears above the input box.
- Login is protected by a password (`APP_PASSWORD`). The Hermes API key stays on the server and never reaches the browser.

## Operation (Docker Compose)

```bash
cd hermes-chat
cp .env.example .env           # first time: fill in HOST / DATA_PATH / APP_PASSWORD
docker compose up -d --build   # start / update
docker compose logs -f         # logs
docker compose down            # stop
```

Address: `http://<HOST>:<PORT>` (set in `.env`, default port `9120`).

## Settings (`.env`)

| Variable | Description |
|---|---|
| `HOST`, `PORT` | Listen address, e.g. a private/tailnet IP; default port `9120` |
| `DATA_PATH` | **Required.** Absolute path of the data folder, e.g. `/path/to/hermes-chat/data`; mounted at the same path inside the container |
| `APP_PASSWORD` | Login password |
| `HERMES_URL` | Defaults to `API_SERVER_HOST:PORT` from `~/.hermes/.env` |
| `HERMES_API_KEY` | Defaults to `API_SERVER_KEY` from `~/.hermes/.env` |
| `MAX_UPLOAD_MB` | Size limit per upload, default 200 |

## Design notes

- `network_mode: host`, so the container can reach the Hermes API on the tailnet IP directly.
- `./data` is mounted inside the container at the same absolute path as on the host (`DATA_PATH`). The file paths that Hermes on the host sees and the ones the container serves are therefore identical.
- `~` is mounted read-only, so you can download files Hermes wrote anywhere in your home directory. Paths that contain a hidden directory (`.ssh`, `.hermes`, …) are always refused.
- The container runs as UID 1000, so files it creates are owned by you and Hermes can write to them.
