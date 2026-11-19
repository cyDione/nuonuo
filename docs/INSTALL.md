# Installation & Deployment Guide

**English** | [简体中文](INSTALL.zh-CN.md) · [Back to README](../README.md)

Everything in Nuonuo — daemon, SQLite state, files, and local execution — runs on your own machine. By default it binds only to `127.0.0.1:7420`, never opens public ports, and uses your own LLM API keys.

## Table of Contents

- [Prebuilt Packages (Recommended)](#prebuilt-packages-recommended)
  - [macOS Desktop App](#macos-desktop-app)
  - [Windows Desktop App](#windows-desktop-app)
  - [Linux / Headless Server](#linux--headless-server)
- [Build & Run from Source](#build--run-from-source)
- [First-Run Setup & Model Providers](#first-run-setup--model-providers)
- [Remote & LAN Access](#remote--lan-access)
- [Execution Isolation & Cloud Desktop](#execution-isolation--cloud-desktop)
- [Upgrading & Migration](#upgrading--migration)
- [CLI Reference](#cli-reference)
- [Data Directory & Security](#data-directory--security)
- [Troubleshooting](#troubleshooting)

---

## Prebuilt Packages (Recommended)

Every [GitHub Release](https://github.com/cyDione/nuonuo/releases) ships self-contained packages with Node.js bundled — no separate runtime installation required.

| Platform | Architecture | Artifact | Form |
| --- | --- | --- | --- |
| **macOS** | Apple Silicon (`arm64`), Intel (`x64`) | `nuonuo-<version>-mac-<arm64\|x64>.dmg` (or `.zip`) | Desktop app (embedded daemon; optional web access) |
| **Windows** | `x64`, `arm64` | `nuonuo-<version>-win-<x64\|arm64>-setup.exe` (or portable `.zip`) | Desktop app (embedded daemon; optional web access) |
| **Linux (Server / Headless)** | `x64` (`amd64`), `arm64` (`aarch64`) | `nuonuo-<version>-linux-<x64\|arm64>.tar.gz` | Background daemon + Web UI |

### macOS Desktop App

**One-line install / update** (auto-detects Apple Silicon vs. Intel, even inside a Rosetta shell, and installs `Nuonuo.app` into `/Applications` or `~/Applications`):

```sh
curl -fsSL https://raw.githubusercontent.com/cyDione/nuonuo/main/install.sh | bash
```

- Open Nuonuo from **Launchpad** or run `open /Applications/Nuonuo.app`.
- To upgrade later, quit Nuonuo from the menu bar icon and re-run the same command (your `~/.nuonuo` data directory is untouched).
- To pin a specific release: `NUONUO_VERSION=v0.3.12 curl -fsSL https://raw.githubusercontent.com/cyDione/nuonuo/main/install.sh | bash`.
- Files downloaded via `curl` do not receive macOS's browser quarantine attribute, so Gatekeeper will not block the first launch even before Developer ID notarization is configured.

**Manual `.dmg` install**:

Download `nuonuo-<version>-mac-<arm64|x64>.dmg` from [Releases](https://github.com/cyDione/nuonuo/releases). If macOS warns that the developer cannot be verified before notarization is enabled, clear the quarantine attribute before opening the `.dmg` (or after dragging the app into `/Applications`):

```sh
xattr -cr ~/Downloads/nuonuo-<version>-mac-<arch>.dmg
# Or if already installed:
xattr -dr com.apple.quarantine /Applications/Nuonuo.app
```

**Desktop tips**:
- Closing the window keeps Nuonuo running quietly in the menu bar / tray.
- Press `⌘⇧Space` (`Ctrl+Shift+Space` on Windows) anywhere to open Quick Ask or summon the window.
- Web access is off by default in desktop builds; enable it under **Settings → System → Web access** (`Local only` or `LAN`) and restart the service.

### Windows Desktop App

1. Download `nuonuo-<version>-win-<x64|arm64>-setup.exe` (or the portable `.zip`) from [Releases](https://github.com/cyDione/nuonuo/releases).
2. Run the installer. If Windows SmartScreen prompts because the build is unsigned, choose **More info → Run anyway**.
3. Launch **Nuonuo** from the Start Menu. The daemon and Node.js are bundled inside the app.

### Linux / Headless Server

**One-line install** (auto-detects `x64` / `arm64`, installs into `~/.local/share/nuonuo`, symlinks `~/.local/bin/nuonuo`):

```sh
curl -fsSL https://raw.githubusercontent.com/cyDione/nuonuo/main/install.sh | bash
```

> If `~/.local/bin` is not on your `PATH`, add `export PATH="$HOME/.local/bin:$PATH"` to `~/.bashrc` or `~/.zshrc`.
> You can customize install paths with `NUONUO_PREFIX` and `NUONUO_BIN_DIR`, or pin a version with `NUONUO_VERSION=v0.3.12`.

**Start in the background**:

```sh
nuonuo start -d
```

The command prints an authenticated login URL:

```text
http://127.0.0.1:7420/auth?token=...
```

Open that URL in your browser. To check environment health or re-print the link anytime:

```sh
nuonuo doctor
nuonuo token
```

**Start automatically at login (systemd user service)**:

```sh
nuonuo service install
loginctl enable-linger "$USER"   # keep running even when no desktop/SSH session is active
```

> [!IMPORTANT]
> Never run Nuonuo as `root`. Use a dedicated non-privileged user, and enable Docker sandbox mode (`Settings → Security & execution`) if you want stronger filesystem isolation.

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

### Start the Daemon

```sh
node apps/daemon/dist/cli.mjs doctor
node apps/daemon/dist/cli.mjs start
```

Optional shell alias:

```sh
alias nuonuo="node ~/nuonuo/apps/daemon/dist/cli.mjs"
```

### Run the Desktop App from Source

```sh
pnpm build
cd apps/desktop && pnpm start
```

### Local Development Mode

```sh
pnpm dev     # daemon (tsx watch, data dir ./.nuonuo-dev) + Vite HMR (http://localhost:5173)
pnpm check   # typecheck + unit/integration tests + production build
```

---

## First-Run Setup & Model Providers

On first open, Nuonuo guides you right inside the **Main chat** — no wizard forms required:

1. **Connect a model provider**: Enter an API key (or configure a local Ollama / LM Studio endpoint). Built-in presets include:
   - **Anthropic**, **OpenAI**, **Google Gemini**, **DeepSeek**
   - **OpenRouter**, **DashScope (Qwen)**, **Moonshot Kimi**, **Zhipu GLM**, **SiliconFlow**
   - **Ollama** (`http://127.0.0.1:11434/v1`), **LM Studio** (`http://127.0.0.1:1234/v1`), and any custom **OpenAI-compatible** gateway
   - **TypeSafe Jev** (optional decision model dedicated to the Reviewer layer)
2. **Optional env-file configuration** (especially handy for headless servers and `systemd` / `launchd` services, which do not read interactive shell `export`s):

   ```sh
   mkdir -p ~/.nuonuo
   printf 'OPENAI_API_KEY=sk-...\n' > ~/.nuonuo/env
   chmod 600 ~/.nuonuo/env
   ```

   Supported environment variables include `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, matching `*_BASE_URL` overrides, and optional `NUONUO_MODEL=<model-id>` for initial model selection.
3. **12-Layer Model Routing** (**Settings → Models**): Assign separate models, fallback chains, reasoning effort, and daily token/USD budgets per layer — `router`, `voice`, `worker`, `subagent`, `filter`, `reviewer`, `watchdog`, `summarizer`, `embedding`, `vision`, `transcribe`, and `speech`. Unconfigured layers automatically inherit safely from their parent layer.
4. **Connect sources & choose proactivity**: Enable Telegram, Feishu/Lark, Discord, WeCom, DingTalk, Slack, GitHub, or Gmail, pick your proactive level, and optionally import memories from another AI.

---

## Remote & LAN Access

By default Nuonuo listens only on `127.0.0.1:7420`.

### Option A: SSH Tunnel (Recommended for Remote Servers)

```sh
ssh -L 7420:127.0.0.1:7420 user@your-server
```

Then open the `http://127.0.0.1:7420/auth?token=...` link locally.

### Option B: Trusted LAN Access

```sh
# One-off
nuonuo start -d --host 0.0.0.0 --port 7420

# Persist to ~/.nuonuo/config.json
nuonuo config --host 0.0.0.0 --port 7420
nuonuo restart
```

Address precedence: CLI flags (`--host` / `--port`) > environment variables (`NUONUO_HOST` / `NUONUO_PORT`) > `~/.nuonuo/config.json` > default `127.0.0.1:7420`.

> [!WARNING]
> The login link token acts as your password over plain HTTP. Use `--host 0.0.0.0` only on a trusted LAN, or place Nuonuo behind an HTTPS reverse proxy when exposing it remotely.

### Option C: Chat Channels & Paired Devices

- Enable **Telegram**, **Feishu/Lark**, **Discord**, **WeCom**, **DingTalk**, or **Slack** (all use outbound long-polling / WebSocket / Stream — no public port required) to message your home machine from your phone.
- Pair custom devices (mobile apps, watches, speakers, scripts) via `nuonuo pair` using the [Client Protocol](11-client-protocol.md) and [`@nuonuo/client`](../packages/client).

---

## Execution Isolation & Cloud Desktop

- **Folder Boundaries**: Configure **Read only**, **Can edit**, and **Never touch** directories under **Permissions**. Symlinks are resolved to real paths before verification; `~/.ssh`, `~/.gnupg`, and OS keychains are blocked by default.
- **Docker Sandbox**: Under **Settings → Security & execution**, set Docker sandbox to **External tasks** or **All tasks**. Only authorized folders are mounted into the container, and `Never touch` subpaths are masked.
- **Cloud Linux Desktop (e.g. Instabox)**: Run Workers inside an isolated cloud Linux machine with a `1280×800` X11 desktop and persistent headed Chromium browsers, while watching or taking over live 60fps streams directly from the right pane's **Browser** tab. Install the sample provider under **Settings → Plugins → Install plugin**:
  ```text
  cyDione/nuonuo/tree/main/plugins/instabox
  ```
  See [Cloud Computers](13-computers.md) for details.

---

## Upgrading & Migration

- **Linux (installed via `install.sh`)**:
  ```sh
  nuonuo update --check   # check for a newer release
  nuonuo update           # download, install, and restart systemd service if active
  ```
  You can also trigger updates from **Settings → System → Updates** in the Web UI. Set `NUONUO_UPDATE_CHECK=0` in `~/.nuonuo/env` to disable background update checks.
- **macOS Desktop**: Quit Nuonuo and re-run the `curl ... install.sh | bash` command, or download the latest `.dmg` from Releases.
- **Windows Desktop**: Download and run the latest `setup.exe` over your existing install.
- **From Source**:
  ```sh
  cd ~/nuonuo && git pull && pnpm install && pnpm build
  nuonuo restart   # or: nuonuo service install
  ```
- **Migrating from `super-assistant` (`<= v0.2.4`)**: Updating automatically migrates `~/.super-assistant` to `~/.nuonuo` (leaving a compatibility symlink), migrates credentials and systemd units, and keeps `SUPER_ASSISTANT_*` env vars working.
- **Custom npm registry for plugins** (helpful behind slow registries): set `NUONUO_NPM_REGISTRY=https://registry.npmmirror.com` in `~/.nuonuo/env`.

---

## CLI Reference

| Command | Description |
| --- | --- |
| `nuonuo start [-d] [-H <ip>] [-p <port>] [--no-open]` | Start the daemon (`-d` runs detached; logs at `~/.nuonuo/logs/daemon.log`) |
| `nuonuo stop` / `nuonuo restart` | Stop or restart the background daemon |
| `nuonuo status` | Check PID, bind address, version, uptime, and background outbox health |
| `nuonuo config [-H <ip>] [-p <port>] [--web on\|off]` | Inspect or save default host, port, and desktop web-access settings |
| `nuonuo doctor` | Diagnose Node.js, secrets storage, model setup, git/gh, and Docker |
| `nuonuo token [--rotate]` | Print the login URL (`--rotate` generates a new token; restart to apply) |
| `nuonuo pair [--name <n>] [--approvals] [--no-notices]` | Generate a 10-minute one-time pairing code for `/client/v1` devices |
| `nuonuo devices [list \| revoke <id>]` | List or revoke paired client devices |
| `nuonuo channel presets` / `channel new <name> [--preset <p>]` | Scaffold a custom chat-channel plugin adapter |
| `nuonuo update [--check]` | Check for or install the latest Linux release |
| `nuonuo service install \| uninstall` | Configure login autostart (`launchd` on macOS, `systemd --user` on Linux) |

---

## Data Directory & Security

- **Data directory**: `~/.nuonuo/` by default (override via `NUONUO_HOME`), containing `state.db` (SQLite), `token` (`0600`), `config.json`, `env`, `work/`, `memory/`, `secrets/`, and `logs/`.
- **Encrypted API keys**: Keys never enter SQLite, logs, model contexts, or Worker shell environments. macOS defaults to an encrypted file (`secrets/secrets.enc`, AES-256-GCM with `0600` `master.key`) to prevent repeated Keychain prompts; Linux and Windows prefer OS credential stores with automatic encrypted-file fallback on headless systems (`NUONUO_SECRETS=file|keychain` overrides).
- **Strict API auth**: Every API call requires a valid token (`HttpOnly; SameSite=Strict` session cookie or `Bearer` header) and validates `Host` and `Origin` headers to prevent DNS rebinding and CSRF.

---

## Troubleshooting

- **macOS says the app is damaged or cannot be verified**: Run `xattr -dr com.apple.quarantine /Applications/Nuonuo.app` or install via `install.sh`.
- **Lost your login link**: Run `nuonuo token` (or `nuonuo token --rotate` if you want to invalidate old sessions).
- **Forgot where logs are**: Check `~/.nuonuo/logs/daemon.log` and run `nuonuo doctor`.
- **More operations details** (release packaging, macOS signing/notarization, OAuth app creation): see [docs/deploy.md](deploy.md) and [docs/10-oauth.md](10-oauth.md).
