# Hermes Chat

A ChatGPT-style web chat for a self-hosted [Hermes Agent](https://github.com/NousResearch/hermes-agent), built on the Hermes API server.

- Text chat with streaming replies, Markdown, and code highlighting. Tool calls and the thinking process show as collapsible sections.
- Attach files and images: click the paperclip, drag and drop, or paste with Ctrl+V. Images go to the model directly; every attachment is also saved under `data/workspace/<session>/uploads/`, and Hermes is told the absolute path so it can read the file with its tools.
- File downloads: Hermes is asked to save output files to `data/workspace/<session>/outputs/`. The folder icon at the top right lists every file in the current chat, and absolute paths in a reply become download links.
- Model switching: the model menu lists every model from the providers Hermes is signed in to, with search and a reasoning-effort choice. The choice is locked to that chat (`require_model_lock`) and kept when you reopen it.
- MCP and Skills management (optional, through the Hermes dashboard): enable/disable, test, OAuth login, add/remove MCP servers, install from the MCP catalog; list, toggle, edit, create, search and install skills from the hub.
- The chat list is Hermes's own session list. You can rename and delete chats, show other sources (CLI, Telegram…), and optionally tag sessions another OpenAI-compatible client creates.
- Command approvals appear as a card above the input box.
- Password login. The Hermes API key stays on the server and never reaches the browser.

## Requirements

- **Linux with Docker Compose.** The container uses `network_mode: host` to reach Hermes on the same machine (Docker Desktop on macOS/Windows does not support this by default).
- **Hermes Agent on the same machine**, recent enough to have the sessions API (tested with v0.23). Uploads and downloads work because Hermes and Hermes Chat see the same folder.
- **The Hermes API server enabled.** In `~/.hermes/.env`:
  ```
  API_SERVER_ENABLED=true
  API_SERVER_KEY=<a long random secret, e.g. `openssl rand -hex 32`>
  # optional: API_SERVER_HOST / API_SERVER_PORT (default 127.0.0.1:8642)
  ```
  then restart the gateway (`hermes gateway restart`). Hermes Chat reads the address and key from this file; you don't copy them anywhere.

## Quick start

```bash
git clone https://github.com/jimmy071919/hermes-chat.git
cd hermes-chat
cp .env.example .env        # then set HOST and APP_PASSWORD
# fill in your UID/GID and the absolute data path automatically
sed -i "s/^UID=.*/UID=$(id -u)/; s/^GID=.*/GID=$(id -g)/; s#^DATA_PATH=.*#DATA_PATH=$PWD/data#" .env
mkdir -p data
docker compose up -d --build
```

Open `http://<HOST>:<PORT>` (default port `9120`) and log in with `APP_PASSWORD`.

```bash
docker compose logs -f      # logs
docker compose down         # stop
```

## Settings (`.env`)

| Variable | Description |
|---|---|
| `HOST`, `PORT` | Listen address. `127.0.0.1` for local only, or a private/tailnet IP; default port `9120` |
| `APP_PASSWORD` | Web login password |
| `DATA_PATH` | **Required.** Absolute path of this project's `data` folder; mounted at the same path inside the container |
| `UID`, `GID` | Your user/group id (`id -u`, `id -g`), default `1000` |
| `REPLY_LANGUAGE` | Optional. Language Hermes always answers in, e.g. `Traditional Chinese`. Empty = same language as the user |
| `CHAT_COMPLETIONS_LABEL` | Optional. Tag and filter for sessions created through `/v1/chat/completions` by another client (e.g. a voice assistant). Empty = no tag |
| `HERMES_HOME` | Hermes home folder, default `~/.hermes` |
| `HERMES_URL`, `HERMES_API_KEY` | Override the API address/key read from `$HERMES_HOME/.env` |
| `MAX_UPLOAD_MB` | Size limit per upload, default `200` |
| `DASHBOARD_*` | MCP/Skills management, see below |

## MCP and Skills management (optional)

The Hermes API server has no endpoints for this, so Hermes Chat calls the **Hermes dashboard** (`hermes dashboard`, default port `9119`) and only a whitelist of its MCP/skills routes. Without this configured, everything else still works and the management screen shows setup instructions.

Set `DASHBOARD_URL` if the dashboard is not at `API_SERVER_HOST:9119`, then pick one way to authenticate:

**A. Deployment token (recommended)**

```bash
(umask 077; openssl rand -base64 32 > ~/.hermes/dashboard-session-token)
# start the dashboard with the token, e.g. in its systemd unit:
#   Environment=HERMES_DASHBOARD_SESSION_TOKEN=file:/home/you/.hermes/dashboard-session-token
```

and in `.env`: `DASHBOARD_TOKEN_FILE=/home/you/.hermes/dashboard-session-token` (absolute path under your home folder, which the container can read).

**B. Dashboard login** (if `dashboard.basic_auth` is configured): `DASHBOARD_USER=...` and `DASHBOARD_PASSWORD=...`.

MCP changes apply to new chats; use "restart gateway" on the MCP screen to reload them everywhere.

**MCP OAuth with providers that reject the dashboard's callback URL** (error like "Invalid redirect URI"; some providers only accept `https` or `127.0.0.1`): give the server a loopback callback and clear its old client registration, then log in again from the MCP screen. After authorizing, the browser lands on a `127.0.0.1` page that does not load; paste that URL into the box Hermes Chat shows.

```bash
hermes config set mcp_servers.<name>.oauth.redirect_uri http://127.0.0.1:<port>/callback
rm ~/.hermes/mcp-tokens/<name>.client.json
```

## Design notes

- Your home folder is mounted read-only so you can download files Hermes writes anywhere in it, and so the container can read `$HERMES_HOME/.env` and the optional dashboard token. Paths containing a hidden directory (`.ssh`, `.hermes`, …) are never served for download.
- The container runs as `UID:GID`, so files it creates are owned by you and Hermes can write to them.
- No build step and no npm dependencies: a single `server.mjs` (Node 20+) plus static files; the frontend libraries are vendored in `public/vendor/`.
