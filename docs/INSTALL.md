# Installation & Deployment Guide

**English** | [简体中文](INSTALL.zh-CN.md) · [Back to README](../README.md)

Starting with **v0.4**, Nuonuo separates its **standalone headless `/v1` server** from **thin clients** (macOS desktop app, web browser, mobile/SDK clients). Everything — server, SQLite state, files, and local execution — runs on your own hardware, binds only to `127.0.0.1:7420` by default, and uses your own LLM API keys.

## Table of Contents

- [Prebuilt Packages (Recommended)](#prebuilt-packages-recommended)
  - [Standalone Server (Linux & macOS CLI)](#standalone-server-linux--macos-cli)
  - [Docker Deployment](#docker-deployment)
  - [Thin macOS Desktop App](#thin-macos-desktop-app)
- [Build & Run from Source](#build--run-from-source)
- [Authentication & Pairing](#authentication--pairing)
- [First-Run Setup & Model Providers](#first-run-setup--model-providers)
- [Remote & LAN Access](#remote--lan-access)
- [Execution Isolation & Cloud Desktop](#execution-isolation--cloud-desktop)
- [Upgrading & Migration](#upgrading--migration)
- [CLI Reference](#cli-reference)
- [Data Directory & Security](#data-directory--security)
- [Troubleshooting](#troubleshooting)

---

## Prebuilt Packages (Recommended)

Every [GitHub Release](https://github.com/cyDione/nuonuo/releases) publishes self-contained server packages (with Node.js bundled) and thin desktop apps:

| Platform | Architecture | Artifact | Form |
| --- | --- | --- | --- |
| **Linux (Standalone Server)** | `x64` (`amd64`), `arm64` (`aarch64`) | `nuonuo-<version>-linux-<x64\|arm64>.tar.gz` | Headless `/v1` daemon + optional `--web` UI (Node.js bundled) |
| **macOS (Standalone Server CLI)** | Apple Silicon (`arm64`), Intel (`x64`) | `nuonuo-<version>-darwin-<arm64\|x64>.tar.gz` | Headless `/v1` daemon + optional `--web` UI (Node.js bundled) |
| **macOS (Thin Desktop App)** | Apple Silicon (`arm64`), Intel (`x64`) | `nuonuo-<version>-mac-<arm64\|x64>.dmg` (or `.zip`) | Thin Electron client (zero bundled Node.js/daemon; remote connect & on-demand Local Deploy) |

> Note: `v0.4.0` ships Linux/macOS servers and macOS desktop packages. Other desktop targets (such as Windows) can be built from source via `pnpm --filter @nuonuo/desktop dist:win`.

### Standalone Server (Linux & macOS CLI)

**Linux (`x64` / `arm64`) — one-line install**:
```sh
curl -fsSL https://raw.githubusercontent.com/cyDione/nuonuo/main/install.sh | bash
```

**macOS standalone server CLI (`arm64` / `x64`) — one-line install**:
```sh
curl -fsSL https://raw.githubusercontent.com/cyDione/nuonuo/main/install.sh | bash -s -- --server
```

> Both install into `~/.local/share/nuonuo` and symlink `~/.local/bin/nuonuo`. If `nuonuo` is not found, add `export PATH="$HOME/.local/bin:$PATH"` to `~/.bashrc` or `~/.zshrc`.
> Customize paths with `NUONUO_PREFIX` / `NUONUO_BIN_DIR`, or pin a version with `NUONUO_VERSION=v0.4.0`.

**Start the server**:
```sh
# Headless /v1 API only (default, recommended when pairing from desktop/mobile/SDK)
nuonuo start -d

# Or enable the built-in WebUI at http://127.0.0.1:7420
nuonuo start -d --web
```

**Generate a one-time pairing code & QR code**:
```sh
nuonuo pair --admin --qr
```

**Enable login autostart**:
```sh
nuonuo service install           # macOS launchd / Linux systemd --user
loginctl enable-linger "$USER"   # Linux: keep running after SSH logout
```

> [!IMPORTANT]
> Never run the server as `root`. Use a dedicated non-privileged user, and enable Docker sandbox mode under **Settings → Security & execution** for stronger filesystem isolation.

### Docker Deployment

Run the standalone server via Docker Compose using the repository's `Dockerfile` and `docker-compose.yml`:

```sh
# Headless API by default (set NUONUO_WEB=1 to also serve the built-in WebUI)
NUONUO_WEB=1 docker compose up -d

# Generate a one-time admin pairing code inside the container
docker exec -it nuonuo-server nuonuo pair --admin --qr
```

Data persists in `${NUONUO_DATA_DIR:-~/.nuonuo}` mounted at `/data`, with `NUONUO_SECRETS=file` enabled automatically for headless containers.

### Thin macOS Desktop App

**One-line install / update** (auto-detects Apple Silicon vs. Intel even under Rosetta, installs `Nuonuo.app` into `/Applications` or `~/Applications`):

```sh
curl -fsSL https://raw.githubusercontent.com/cyDione/nuonuo/main/install.sh | bash
```

- Launch from **Launchpad** or run `open /Applications/Nuonuo.app`.
- Enter any Nuonuo server URL + pairing code (or click **Scan QR** / open a `nuonuo://pair?...` deep link) to connect.
- Haven't deployed a server yet? Click **Deploy locally in one click** at the bottom of the Connect screen to install/start a local or Docker server and pair automatically.
- To upgrade later, quit Nuonuo from the menu bar icon and re-run the same `curl` command.
- Pin a version with `NUONUO_VERSION=v0.4.0 curl -fsSL https://raw.githubusercontent.com/cyDione/nuonuo/main/install.sh | bash`.

**Manual `.dmg` install**:

Download `nuonuo-<version>-mac-<arm64|x64>.dmg` from [Releases](https://github.com/cyDione/nuonuo/releases). If Gatekeeper warns before Developer ID notarization is configured, clear the quarantine attribute:

```sh
xattr -cr ~/Downloads/nuonuo-<version>-mac-<arch>.dmg
# Or if already dragged into /Applications:
xattr -dr com.apple.quarantine /Applications/Nuonuo.app
```

**Desktop tips**:
- Closing the window keeps Nuonuo running quietly in the menu bar / tray.
- Press `⌘⇧Space` anywhere to open Quick Ask (`Alt+Space` to summon the main window).
- On macOS, desktop refresh tokens are encrypted with `AES-256-GCM` + an atomic mode-`0600` `vault.key` beside `vault.json`, and Chromium OSCrypt Keychain lookup is disabled by default — so ad-hoc signed builds never trigger macOS Keychain password prompts (set `NUONUO_MAC_KEYCHAIN=1` to opt into macOS Keychain on notarized builds).

---

## Build & Run from Source

### Prerequisites

- **Node.js** `>= 22.12`
- **pnpm** `10.x`
- **git**
- Optional: `gh` CLI (GitHub), **Docker** (container sandbox), **Chrome / Chromium** (local browser tools)

### Clone & Build

```sh
git clone https://github.com/cyDione/nuonuo.git ~/nuonuo
cd ~/nuonuo
pnpm install
pnpm build
```

### Start Server from Source

```sh
node apps/daemon/dist/cli.mjs doctor
node apps/daemon/dist/cli.mjs start --web
# In another terminal:
node apps/daemon/dist/cli.mjs pair --admin --qr
```

Optional shell alias:
```sh
alias nuonuo="node ~/nuonuo/apps/daemon/dist/cli.mjs"
```

### Launch Thin Desktop App from Source

```sh
pnpm build
cd apps/desktop && pnpm start
```

### Local HMR Development & Verification

```sh
pnpm dev     # starts daemon (data dir ./.nuonuo-dev) + Vite HMR (http://localhost:5173)
pnpm check   # runs 11-workspace typecheck + full Vitest suite + production builds
pnpm eval    # runs zero-token offline prompt/voice/guardrail regression suite
```

---

## Authentication & Pairing

Unified `/v1/*` Protocol 2.0 supports three authentication methods, all issuing short-lived HMAC Access Tokens (`nna_…`, 15 min) plus single-use rotating Refresh Tokens (`nnr_…`, 30 days) with full token-family revocation if replay is detected:

1. **One-time Pairing Code & QR (default)**:
   ```sh
   nuonuo pair --admin --qr
   ```
   Valid for 10 minutes (locks out after 10 invalid attempts). Paste the code, scan the QR code, or open the `nuonuo://pair?server=...&code=...` URI directly.
2. **Owner Password (`scrypt`)**:
   ```sh
   nuonuo auth set-password "your-strong-password"
   ```
   Enables direct password sign-in from the Connect screen (protected by loopback-verified IP rate limiting).
3. **WebAuthn Passkeys**:
   After pairing on `localhost` or HTTPS, register a Touch ID / Face ID / hardware Passkey under **Settings → System → Devices & Security** for passwordless re-authentication.

Manage paired devices and active sessions anytime:
```sh
nuonuo devices list
nuonuo devices revoke <device-id>
nuonuo sessions list
nuonuo sessions revoke <session-id>
```

---

## First-Run Setup & Model Providers

On first sign-in, Nuonuo walks you through 4 conversational setup steps right inside **Main chat**:

1. **Add a model provider**: Enter your own API key or connect local Ollama / LM Studio. Built-in presets cover **Anthropic**, **OpenAI**, **Google Gemini**, **DeepSeek**, **OpenRouter**, **DashScope (Qwen)**, **Moonshot Kimi**, **Zhipu GLM**, **SiliconFlow**, **Ollama** (`http://127.0.0.1:11434/v1`), **LM Studio** (`http://127.0.0.1:1234/v1`), **TypeSafe Jev** (optional reviewer decision model), and any custom OpenAI-compatible gateway.
2. **Optional `~/.nuonuo/env` file** (recommended for background services / servers that don't inherit shell exports):
   ```sh
   mkdir -p ~/.nuonuo
   printf 'OPENAI_API_KEY=sk-...\n' > ~/.nuonuo/env
   chmod 600 ~/.nuonuo/env
   ```
   Supports `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, matching `*_BASE_URL` overrides, and `NUONUO_MODEL=<model-id>`.
3. **12-layer model routing** (**Settings → Model layers**): Configure independent models, fallbacks, reasoning levels, and daily budgets for `router`, `voice`, `worker`, `subagent`, `filter`, `reviewer`, `watchdog`, `summarizer`, `embedding`, `vision`, `transcribe`, and `speech`.
4. **Connect sources & set proactivity**: Enable Telegram, Feishu/Lark, Discord, WeCom, DingTalk, Slack, GitHub, Gmail, or import memories from other AI tools.

---

## Remote & LAN Access

By default, the server binds only to `127.0.0.1:7420`.

### Option 1: SSH Port Forwarding (Safest for VPS / Remote Hosts)

```sh
ssh -L 7420:127.0.0.1:7420 user@your-server
```

Then point your desktop app or browser to `http://127.0.0.1:7420` and pair with `nuonuo pair --admin --qr`.

### Option 2: Trusted LAN or HTTPS Reverse Proxy

```sh
# Persist network & WebUI settings to ~/.nuonuo/config.json
nuonuo config --host 0.0.0.0 --port 7420 --web on
nuonuo restart
```

Precedence: CLI flags (`--host` / `--port` / `--web`) > environment variables (`NUONUO_HOST` / `NUONUO_PORT` / `NUONUO_WEB`) > `~/.nuonuo/config.json` > default `127.0.0.1:7420` (headless).

> [!WARNING]
> Listening directly on `0.0.0.0` serves plain HTTP. Use it only on a trusted LAN or behind an HTTPS reverse proxy (Caddy / Nginx / Cloudflare Tunnel / Tailscale Serve) for internet access.

### Option 3: Chat Channels & Custom `/v1/*` Clients

- **Telegram / Feishu / Discord / WeCom / DingTalk / Slack** use outbound connections / long polling / Stream mode — no public IP or open inbound port required.
- Use `nuonuo pair` + [`@nuonuo/client`](../packages/client) over unified [`/v1/*`](11-client-protocol.md) to connect custom mobile apps, scripts, or companion devices.

---

## Execution Isolation & Cloud Desktop

- **Code-enforced folder & secret boundaries**: Set per-folder rules (**Can see / Can edit / Never touch**) in the right **Permissions** pane. Symlinks are resolved before validation; `~/.ssh`, `~/.gnupg`, and OS keychains are locked out by default.
- **Docker sandbox**: Set **Settings → Security & execution → Docker sandbox** to **External tasks** or **All tasks** to mount only authorized directories inside a container.
- **Cloud Linux Desktop (e.g., Instabox)**: Run Workers inside an isolated cloud Linux container with a `1280×800` X11 GUI desktop and persistent headed Chromium, complete with 60fps interactive **Take over** in the right **Browser** pane. Install under **Settings → Plugins → Install plugin**:
  ```text
  cyDione/nuonuo/tree/main/plugins/instabox
  ```
  See [Cloud Computers](13-computers.md) for details.

---

## Upgrading & Migration

- **Standalone Server (`install.sh` package)**:
  ```sh
  nuonuo update --check
  nuonuo update
  ```
  Or update from **Settings → System → Updates** (`NUONUO_UPDATE_CHECK=0` in `~/.nuonuo/env` disables automatic checks).
- **Thin macOS Desktop App**: Quit `Nuonuo.app`, then re-run `curl -fsSL https://raw.githubusercontent.com/cyDione/nuonuo/main/install.sh | bash` (or install the latest `.dmg`).
- **Source Deployment**:
  ```sh
  cd ~/nuonuo && git pull && pnpm install && pnpm build
  nuonuo restart
  ```
- **Legacy `super-assistant` (`<= v0.2.4`)**: Automatically migrates `~/.super-assistant` → `~/.nuonuo` with compatibility symlinks and systemd unit replacement.
- **Faster plugin installs in China**: Add `NUONUO_NPM_REGISTRY=https://registry.npmmirror.com` to `~/.nuonuo/env`.

---

## CLI Reference

| Command | Description |
| --- | --- |
| `nuonuo start [-d] [-H <host>] [-p <port>] [--web \| --no-web]` | Start server (headless by default; `-d` runs in background, logs at `~/.nuonuo/logs/daemon.log`) |
| `nuonuo stop` / `nuonuo restart` | Stop or restart background server |
| `nuonuo status` | Show PID, listen address, WebUI status, version, uptime, and outbox health |
| `nuonuo config [-H <host>] [-p <port>] [--web on\|off]` | Inspect or persist listen host, port, and WebUI toggle in `config.json` |
| `nuonuo pair [--admin] [--qr] [--json] [--scopes ...]` | Issue a 10-min one-time pairing code & QR code for desktop/web/SDK clients |
| `nuonuo auth status \| set-password \| clear-password \| rotate-local-key` | Manage Owner `scrypt` password and loopback `local-admin.key` |
| `nuonuo devices [list \| revoke <id>]` | List or revoke paired client devices |
| `nuonuo sessions [list \| revoke <id>]` | List or immediately terminate active sessions |
| `nuonuo doctor` | Diagnose Node.js, secrets store, models, `git`/`gh`, and Docker |
| `nuonuo channel presets` / `channel new <name> [--preset <id>]` | Scaffold a custom chat-channel plugin adapter |
| `nuonuo update [--check]` | Check for or install the latest standalone server release |
| `nuonuo service install \| uninstall` | Install or remove login autostart (`launchd` / `systemd --user`) |

---

## Data Directory & Security

- **Server data directory**: `~/.nuonuo/` (override with `NUONUO_HOME`), containing `state.db` (SQLite), `local-admin.key` (mode `0600`, loopback CLI auth), `config.json`, `env`, `work/`, `memory/`, `secrets/`, and `logs/`.
- **API key encryption**: Secrets never enter SQLite, logs, model contexts, or Worker shell environments. macOS defaults to `secrets/secrets.enc` (`AES-256-GCM` with mode-`0600` `master.key`) to avoid Keychain prompts; Linux/Windows use the OS keychain when available and fall back to encrypted files (`NUONUO_SECRETS=file|keychain` overrides).
- **Desktop credential vault**: Stored under the Electron userData folder (`vault.json`). macOS uses `AES-256-GCM` + mode-`0600` `vault.key` by default with Chromium OSCrypt Keychain disabled (`NUONUO_MAC_KEYCHAIN=1` opts back into Keychain); Windows/Linux use Electron `safeStorage`.

---

## Troubleshooting

- **macOS warns app is damaged / unverified developer**: Run `xattr -dr com.apple.quarantine /Applications/Nuonuo.app`, or install via `install.sh`.
- **Forgot how to connect / need a fresh device login**: Run `nuonuo pair --admin --qr` on the server host to issue a fresh 10-min one-time code.
- **Server won't start**: Inspect `~/.nuonuo/logs/daemon.log` and run `nuonuo doctor`.
- **Advanced ops, signing & OAuth**: See [Deployment & Ops](deploy.md) and [OAuth Setup](10-oauth.md).
