# Hermes Chat

[English](README.md) | **繁體中文**

給自架 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 用的 ChatGPT 風格網頁聊天介面，透過 Hermes API server 運作。

- 文字聊天：回覆即時串流顯示，支援 Markdown 和程式碼語法上色。Hermes 用了哪些工具、思考過程，都會以可展開的區塊顯示。
- 附加檔案和圖片：點迴紋針、拖曳檔案，或用 Ctrl+V 貼上。圖片會直接交給模型看；所有附件也會存到 `data/workspace/<session>/uploads/`，並把絕對路徑告訴 Hermes，讓它能用工具讀取檔案。
- 下載檔案：Hermes 會被要求把要給你的檔案存到 `data/workspace/<session>/outputs/`。右上角的資料夾圖示會列出這個聊天的所有檔案；回覆裡出現的絕對路徑也會自動變成下載連結。
- 切換模型：模型選單列出 Hermes 已登入的所有 provider 的模型，可以搜尋，也能選推理強度。選好的模型會鎖定在該聊天（`require_model_lock`），之後重新開啟也會沿用。
- MCP、Skills 與模型設定（選用，透過 Hermes dashboard）：MCP 伺服器的啟用／停用、測試連線、OAuth 登入、新增／刪除、從 MCP 目錄安裝；Skills 的列表、啟用／停用、編輯、新增，以及從 Hub 搜尋和安裝；變更 Hermes 的全域預設模型和輔助任務模型，新增或移除 provider 的 API 金鑰。
- 左邊的聊天清單就是 Hermes 本身的 session 清單。可以重新命名、刪除聊天，顯示其他來源（CLI、Telegram…），也可以替其他 OpenAI 相容程式建立的對話加上標籤。
- Hermes 要執行指令需要核准時，輸入框上方會出現核准卡片。
- 有密碼登入。Hermes 的 API 金鑰只留在伺服器端，不會傳到瀏覽器。

## 需求

- **Linux 加上 Docker Compose。** 容器使用 `network_mode: host` 來連同一台機器上的 Hermes（macOS 和 Windows 的 Docker Desktop 預設不支援）。
- **Hermes Agent 裝在同一台機器上**，版本要夠新、有 sessions API（已在 v0.23 測試）。上傳和下載能運作，是因為 Hermes 和 Hermes Chat 看到的是同一個資料夾。
- **開啟 Hermes API server。** 在 `~/.hermes/.env` 加上：
  ```
  API_SERVER_ENABLED=true
  API_SERVER_KEY=<一組夠長的隨機字串，例如用 `openssl rand -hex 32` 產生>
  # 選填：API_SERVER_HOST / API_SERVER_PORT（預設 127.0.0.1:8642）
  ```
  然後重新啟動 gateway（`hermes gateway restart`）。Hermes Chat 會自動從這個檔案讀取位址和金鑰，不用另外複製到別的地方。

## 快速開始

```bash
git clone https://github.com/jimmy071919/hermes-chat.git
cd hermes-chat
cp .env.example .env        # 接著設定 HOST 和 APP_PASSWORD
# 自動填入你的 UID/GID 和 data 資料夾的絕對路徑
sed -i "s/^UID=.*/UID=$(id -u)/; s/^GID=.*/GID=$(id -g)/; s#^DATA_PATH=.*#DATA_PATH=$PWD/data#" .env
mkdir -p data
docker compose up -d --build
```

打開 `http://<HOST>:<PORT>`（有設定 TLS 時用 `https://`；預設 port 是 `9120`），用 `APP_PASSWORD` 登入。

```bash
docker compose logs -f      # 看記錄
docker compose down         # 停止
```

## 設定（`.env`）

| 變數 | 說明 |
|---|---|
| `HOST`、`PORT` | 監聽位址。只在本機用就設 `127.0.0.1`，要從其他裝置連就設內網或 Tailscale IP；預設 port `9120` |
| `APP_PASSWORD` | 網頁登入密碼 |
| `DATA_PATH` | **必填。** 專案 `data` 資料夾的絕對路徑；在容器裡會掛載到相同路徑 |
| `UID`、`GID` | 你的使用者／群組 ID（用 `id -u`、`id -g` 查），預設 `1000` |
| `REPLY_LANGUAGE` | 選填。Hermes 固定使用的回覆語言，例如 `Traditional Chinese`。留空則跟著使用者的語言 |
| `CHAT_COMPLETIONS_LABEL` | 選填。替其他程式（例如語音助理）透過 `/v1/chat/completions` 建立的對話加上標籤和篩選。留空則不顯示 |
| `HERMES_HOME` | Hermes 的主資料夾，預設 `~/.hermes` |
| `HERMES_URL`、`HERMES_API_KEY` | 覆寫從 `$HERMES_HOME/.env` 讀到的 API 位址和金鑰 |
| `MAX_UPLOAD_MB` | 單一檔案上傳大小上限，預設 `200` |
| `TLS_CERT_FILE`、`TLS_KEY_FILE` | 選填。改用 HTTPS，見下方說明 |
| `DASHBOARD_*` | MCP／Skills 管理，見下一節 |

## HTTPS（選用）

在 `.env` 設定 `TLS_CERT_FILE` 和 `TLS_KEY_FILE`（PEM 格式，含中繼憑證；要用家目錄底下的絕對路徑），Hermes Chat 就會在 `PORT` 改用 **HTTPS**，登入 cookie 也會加上 `Secure`。程式會監看憑證檔案，續期後約一分鐘內自動換上新憑證，不需要重啟。

任何憑證都可以用（私有 CA、`mkcert`、公開 CA），瀏覽器要信任簽發的 CA。

以私有 **Step-CA** 為例：先用 `step ca certificate hermes-chat hermes-chat.crt hermes-chat.key --san <你的 IP 或主機名稱> ...` 簽發一次，之後交給續期容器自動處理。續期容器寫在 `compose.override.yaml`（已加入 .gitignore，Docker Compose 會自動載入）：

```yaml
services:
  hermes-chat-cert-renewer:
    image: smallstep/step-ca:0.30.2
    restart: unless-stopped
    user: "1000:1000"          # 和 Hermes Chat 相同的 UID，續期後的金鑰才讀得到
    entrypoint: ["step"]
    command: [ca, renew, --daemon, --ca-url, "https://step-ca:9000", --root, /etc/step/root_ca.crt,
              /certs/hermes-chat.crt, /certs/hermes-chat.key]
    volumes:
      - /path/to/certs/hermes-chat:/certs
      - /path/to/root_ca.crt:/etc/step/root_ca.crt:ro
    networks: [pki]
networks:
  pki:
    external: true
    name: <你的 step-ca 網路名稱>
```

## MCP、Skills 與模型設定（選用）

Hermes API server 沒有提供這類功能的 API，所以 Hermes Chat 改呼叫 **Hermes dashboard**（`hermes dashboard`，預設 port `9119`），而且只開放白名單內的 MCP／Skills／模型路由。寫入 Hermes `.env` 只限 Hermes 自己宣告的 provider 金鑰變數（例如 `DEEPSEEK_API_KEY`），像 `API_SERVER_KEY` 這類金鑰無法從網頁修改。沒設定這部分也不影響其他功能，管理畫面會顯示設定說明。

如果 dashboard 不在 `API_SERVER_HOST:9119`，請設定 `DASHBOARD_URL`，然後擇一設定登入方式：

**A. 部署 token（推薦）**

```bash
(umask 077; openssl rand -base64 32 > ~/.hermes/dashboard-session-token)
# 啟動 dashboard 時帶上這個 token，例如在它的 systemd unit 裡加：
#   Environment=HERMES_DASHBOARD_SESSION_TOKEN=file:/home/you/.hermes/dashboard-session-token
```

並在 `.env` 加上：`DASHBOARD_TOKEN_FILE=/home/you/.hermes/dashboard-session-token`（要用家目錄底下的絕對路徑，容器才讀得到）。

**B. Dashboard 帳密登入**（有設定 `dashboard.basic_auth` 時）：`DASHBOARD_USER=...` 和 `DASHBOARD_PASSWORD=...`。

MCP 的變更會在新的聊天生效；在 MCP 畫面按「重啟 Gateway」可以讓所有地方立即載入。

**MCP OAuth 遇到 provider 不接受 dashboard 回呼網址時**（錯誤像是「Invalid redirect URI」；有些 provider 只接受 `https` 或 `127.0.0.1`）：替該伺服器設定 loopback 回呼網址，並清掉舊的用戶端註冊，再從 MCP 畫面重新登入。授權完成後，瀏覽器會跳到一個打不開的 `127.0.0.1` 頁面，把那頁的網址貼到 Hermes Chat 顯示的輸入框即可。

```bash
hermes config set mcp_servers.<name>.oauth.redirect_uri http://127.0.0.1:<port>/callback
rm ~/.hermes/mcp-tokens/<name>.client.json
```

## 設計說明

- 家目錄以唯讀方式掛載，讓你能下載 Hermes 寫在家目錄任何位置的檔案，容器也能讀取 `$HERMES_HOME/.env` 和選用的 dashboard token。路徑中含有隱藏資料夾（`.ssh`、`.hermes` 等）的檔案一律不提供下載。
- 容器以 `UID:GID` 身分執行，所以它建立的檔案屬於你，Hermes 也能寫入。
- 不需要建置步驟，也沒有 npm 相依套件：只有一個 `server.mjs`（Node 20 以上）加上靜態檔案；前端函式庫已放在 `public/vendor/`。
