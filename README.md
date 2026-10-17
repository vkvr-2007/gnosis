# Gnosis

**A private, always-on personal agent for Windows.** You speak, type or drop in a file, and Gnosis plans the task with **NVIDIA Nemotron** on **Nebius Token Factory**, then does it on your laptop: it opens and drives apps, writes and deploys code, sets reminders and controls your Android phone. Memory, skills and logs stay on your machine, and private requests never leave it.

Built for Track 03 (Personal AI) of the Nebius x NVIDIA Global AI Hackathon.

> **Status:** build step 4 of 10. Working now: the brain, cloud and local model routing, the policy gate and audit log, the dashboard, long-term memory with a memory map, voice with voice ID, and desktop control (open, close and operate Windows apps, with a screenshot fallback and a kill switch). Parallel tasks, reminders, the phone and the coding agent come next. See [the design](docs/architecture.md).

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
- **It remembers you, on your laptop.** After each task Gnosis saves what happened and picks out lasting facts ("you prefer TypeScript", "your mother is Lakshmi"). It recalls the relevant ones before the next task. Sensitive facts, such as phone numbers or health details, are only used when the task stays on the local model. The dashboard's **Memory** tab shows everything it knows as a map, where you can pin or forget any fact.

## Desktop control

Gnosis opens apps by name ("open Spotify", "open Valorant", "open VS Code"), closes them, and works inside them. It reads each window's buttons and fields through Windows UI Automation, so it clicks things by name rather than guessing pixels. When an app doesn't expose its controls (games, video, canvases), it takes a screenshot, marks it with numbered boxes and asks the vision model which one to click.

- **Asks before acting on your behalf.** Clicking a button such as Send, Buy, Pay or Delete needs your OK, even though clicking is otherwise allowed.
- **Screenshots are opt-in per app.** The first time Gnosis wants to send a screenshot of an app to the cloud vision model, it asks; your answer is remembered for that app. Reading a window's text (`read_screen`) stays on your laptop.
- **Kill switch.** Press **Ctrl+Alt+J**, click **Stop** on the dashboard, or say "stop" to halt everything Gnosis is doing.
- If an app isn't installed, Gnosis opens its website instead (Spotify, WhatsApp, YouTube, Gmail and more).

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
llama-server -m nemotron-nano-q4.gguf --port 8081 --jinja -c 8192
```

Without it, Gnosis still works and private requests fail with a clear message instead of going to the cloud.

To try Gnosis with no Nebius key at all, add `models_file: config/models.offline.yaml` to `config/gnosis.yaml`. Every request then runs on the local model: slower, and screenshot tools won't work.

For smarter memory search, also run a small embedding model (memory search falls back to keyword search without it):

```powershell
llama-server -m nomic-embed-text-v1.5.Q8_0.gguf --embeddings --port 8082
```

### Voice

Everything voice-related runs on your laptop: your audio never leaves it.

```powershell
.\.venv\Scripts\python -m pip install -e ".[voice]"
.\scripts\get_voice.ps1                         # Downloads the Piper voice (optional; otherwise the Windows voice is used)
.\.venv\Scripts\python -m gnosis serve --voice
```

Say **"Hey Jarvis"** (the bundled wake word until you [train "Hey Gnosis"](docs/wake-word.md)), wait for the chime, and speak. After Gnosis answers it keeps listening for a few seconds, so you can follow up without the wake word. Say the wake word while it's talking to interrupt it, or say "stop".

**Voice ID** makes sure only you can give owner-level commands by voice. Anyone else gets guest mode: music, the time and opening apps, but nothing personal.

```powershell
.\.venv\Scripts\python -m pip install -e ".[voiceid]"   # Adds PyTorch (CPU), about 1 GB
.\.venv\Scripts\python -m gnosis enroll                 # Read a short script for 30 seconds
```

## Development

```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest
```

| Path | What's there |
|---|---|
| `gnosis/core/` | Orchestrator, model router, LLM client, policy gate, audit log, event bus, tool registry |
| `gnosis/memory/` | Long-term memory: facts, episodes, keyword and vector search, learning, memory map |
| `gnosis/skills/desktop/` | App finder and launcher, UI Automation (read, click, type, shortcuts), screenshot fallback, Spotify |
| `gnosis/voice/` | Microphone and speaker, wake word, end-of-speech detection, speech-to-text, text-to-speech, voice ID, the voice loop |
| `gnosis/skills/` | Tools Gnosis can use (built-ins and memory today; desktop, phone, coder and more next) |
| `gnosis/server/` | Local FastAPI + WebSocket API |
| `web/dashboard/` | Dashboard |
| `config/` | Settings, model routing and policy |
| `docs/architecture.md` | Full design for Gnosis v1 |

## License

Apache-2.0
