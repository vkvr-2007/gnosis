# Gnosis

**A private, always-on personal agent for Windows.** You speak, type or drop in a file, and Gnosis plans the task with **NVIDIA Nemotron** on **Nebius Token Factory**, then does it on your laptop: it opens and drives apps, writes and deploys code, sets reminders and controls your Android phone. Memory, skills and logs stay on your machine, and private requests never leave it.

Built for Track 03 (Personal AI) of the Nebius x NVIDIA Global AI Hackathon.

> **Status:** build step 1 of 10. The brain, the cloud and local model router, the policy gate, the audit log and a dashboard text chat are working. Voice, desktop control, memory, phone and the coding agent come next. See [the design](docs/architecture.md).

## How it works

```
You (voice · text · files · phone)
        │
        ▼
  Orchestrator ──► Model router ──► Nebius Token Factory (Nemotron Super / Nano / VL)
   (agent loop)          └────────► Local Nemotron Nano (private + offline)
        │
        ▼
  Policy gate (allow · ask · deny) ──► Tools: desktop, browser, coder, scheduler, phone…
        │
        ▼
  Audit log + live dashboard
```

- **The model proposes and the policy decides.** Every tool call is checked against [`config/policy.yaml`](config/policy.yaml). Anything irreversible or outward-facing (sending a message, deleting a file, deploying) waits for your approval on the dashboard or phone.
- **Private by default where it matters.** Requests marked private, and any task that has touched your files, screen or personal memory, are routed to the local model. Secrets are masked before anything goes to the cloud.
- **Every action is recorded** in an append-only local audit log you can browse.

## Quick start (Windows)

You need Python 3.11+ and a [Nebius Token Factory](https://tokenfactory.nebius.com) API key.

```powershell
git clone https://github.com/vkvr-2007/gnosis
cd gnosis
.\scripts\install.ps1                 # Creates .venv and installs Gnosis
$env:NEBIUS_API_KEY = "<your key>"
.\.venv\Scripts\python -m gnosis models   # Lists the Nemotron models your key can use
```

Paste the model IDs you want into [`config/models.yaml`](config/models.yaml), then start Gnosis:

```powershell
.\.venv\Scripts\python -m gnosis serve    # Dashboard at http://127.0.0.1:8765
.\.venv\Scripts\python -m gnosis chat     # Or talk to it in the terminal
```

### Optional: local model for private and offline mode

Gnosis runs a small Nemotron Nano locally through [llama.cpp](https://github.com/ggml-org/llama.cpp). On Intel Iris graphics, use the Vulkan build:

```powershell
llama-server -m nemotron-nano-q4.gguf --port 8081
```

Without it, Gnosis still works and private requests fail with a clear message instead of going to the cloud.

## Development

```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest
```

| Path | What's there |
|---|---|
| `gnosis/core/` | Orchestrator, model router, LLM client, policy gate, audit log, event bus, tool registry |
| `gnosis/skills/` | Tools Gnosis can use (built-ins today; desktop, phone, coder and more next) |
| `gnosis/server/` | Local FastAPI + WebSocket API |
| `web/dashboard/` | Dashboard |
| `config/` | Settings, model routing and policy |
| `docs/architecture.md` | Full design for Gnosis v1 |

## License

Apache-2.0
