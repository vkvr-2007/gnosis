# Gnosis

**A private, always-on personal agent for Windows.** You speak, type or drop in a file, and Gnosis plans the task with **NVIDIA Nemotron** on **Nebius Token Factory**, then does it on your laptop: it opens and drives apps, writes and deploys code, sets reminders and controls your Android phone. Memory, skills and logs stay on your machine, and private requests never leave it.

Built for Track 03 (Personal AI) of the Nebius x NVIDIA Global AI Hackathon.

> **Status:** all 10 build steps are done, with a final full test on the laptop to come. Working now: the brain, cloud and local model routing, the policy gate and audit log, the dashboard, long-term memory with a memory map, voice with voice ID, desktop control (open, close and operate Windows apps, with a screenshot fallback and a kill switch), parallel tasks, reminders, routines and proactive notices, the phone (a companion app, plus calls and messages on Android), the coding agent (build, push to GitHub, deploy to Vercel), teach mode with saved skills, and a hosted demo on Nebius. See [the design](docs/architecture.md).

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

## Parallel tasks

Every request runs as its own task, so you can ask for the next thing while the last one is still working ("build me a landing page", then "also email Rahul I'll be late"). Each task shows as a card on the dashboard with its status and what it's doing, and you can pause, resume or cancel it there or by asking ("how's the website going?", "pause the website one").

- **One task drives the screen at a time.** The mouse, keyboard and front window are shared, so the first task that uses them keeps them until it finishes and other desktop tasks wait their turn. Tasks that only use the network, memory or the coder sandbox run side by side.
- **Voice stays free.** If a spoken request takes more than a few seconds, Gnosis says it's on it, keeps listening, and tells you when the task is done.

## Reminders and proactive Gnosis

- **Reminders and routines.** "Remind me to call mom at 7", "every weekday at 9 remind me about standup", or "every Sunday evening check for Windows updates" (a routine: Gnosis does the task by itself and tells you the result). They're saved on your laptop, so they survive restarts; one that came due while Gnosis was off fires when it starts again.
- **Watchers** keep an eye on your battery, disk space and new Windows updates, and tell you when something changes.
- **"Should I speak?"** Gnosis decides how to tell you: urgent things (battery at 9%) are always spoken; reminders pop up and are spoken unless you're gaming, presenting, in quiet hours or have said "do not disturb"; everything else waits for your briefing. It also limits how often it interrupts.
- **Briefings.** Say "good morning" or "what did I miss?", or get one automatically every morning (`proactive.morning_briefing` in `config/gnosis.yaml`).

## Your phone

**Companion app.** Click **Pair phone** on the dashboard and scan the QR code. Gnosis opens on your phone, already signed in: chat, hold-to-talk, your task cards, approvals and notices. Each phone gets its own token, and you can unpair it from the dashboard.

- To reach Gnosis from anywhere, install [Tailscale](https://tailscale.com) on the laptop and phone, run `tailscale serve --bg 8765` on the laptop, and put the `https://…ts.net` address in `phone.url` in `config/gnosis.yaml`. HTTPS is also what lets the phone use its microphone and get notifications (`pip install -e ".[phone]"`). On home Wi-Fi only, set `server.host: 0.0.0.0` instead.
- When you're away from the laptop, reminders and alerts are pushed to the phone.

**Phone control (Android).** Gnosis calls, texts, sends WhatsApp messages, opens apps and reads notifications on your phone over wireless debugging. Calls and messages always ask you first.

```powershell
.\scripts\get_adb.ps1                                   # Downloads adb
# Phone: Developer options > Wireless debugging > Pair device with pairing code
.\.venv\Scripts\python -m gnosis phone pair 192.168.1.20:37000 123456
.\.venv\Scripts\python -m gnosis phone connect 192.168.1.20:41235   # The address under Wireless debugging
```

Then say "sync my contacts" once, and "call Amma" or "WhatsApp Rahul that I'm running late" works by name. Contacts are saved on the laptop as sensitive facts.

## Coding, from idea to live URL

"Build me a landing page for a coffee shop called Ember and deploy it." Gnosis creates the project, writes the code, runs the build, reads the errors and fixes them until it works, then pushes it to your GitHub and deploys it to Vercel. You get the link on screen and on your phone. Say "open it in VS Code" to watch.

- **It codes in a sandbox.** Projects live in a separate WSL2 Ubuntu called "Gnosis", which can't see your Windows drives or start Windows programs. Set it up once:

  ```powershell
  .\scripts\setup_wsl.ps1      # About 1 GB: Ubuntu 24.04, Node 22, git, GitHub CLI
  [Environment]::SetEnvironmentVariable('GH_TOKEN', '<GitHub token>', 'User')
  [Environment]::SetEnvironmentVariable('VERCEL_TOKEN', '<Vercel token>', 'User')
  ```

- **Publishing asks first.** Pushing to GitHub and deploying each ask once per project. The tokens are only passed to those two commands, never to the code Gnosis writes.

## Teach mode and saved skills

Show Gnosis a task once and it can do it again. Say "watch me", do the task in any Windows app, then say "done". Gnosis shows you the steps it saw, asks which values change each time (a month, a file name), and saves it as a skill. Later, "do the monthly report for March" runs it. You can also say "save that as a skill" after Gnosis finishes something you asked for.

- **It records what you clicked, not where.** Each click is saved by the button or field's name, so a skill still works when windows move or the screen size changes.
- **Some things are never recorded.** Typing in password fields, and anything while a password manager is in front.
- **Skills are plain files you can read and edit.** Each one is a `SKILL.md` in `%USERPROFILE%\.gnosis\skills\<name>\`, with the steps listed in English and as JSON.
- **A skill can't do more than you could ask for directly.** Saving one asks you first, and every step goes through the same approval rules as a normal request. Skills can't save, run or delete other skills, or change the rules.

## Files and the camera

Attach files and photos to any request with 📎 or 📷 on the dashboard, or 📷 in the phone app (which offers the phone's camera). Text files are read into the request; images are shown to the Nemotron vision model when Gnosis needs to look at them. You can also ask by voice, "Hey Gnosis, what am I holding?", and Gnosis takes one photo with the laptop's camera after you approve it (install with `pip install -e ".[camera]"`). Photos from the camera aren't saved, and attachments are deleted after a week.

## Hosted demo

A cut-down Gnosis runs on a Nebius VM so you can try it without a Windows laptop: chat and approvals from your phone or browser, tasks, reminders, memory, saved skills and the coding agent. Ask for an invite link; each link works once. To run your own, see [deploy/README.md](deploy/README.md).

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

Say **"Hey Gnosis"**, wait for the chime, and speak. Or say it in one breath: "Hey Gnosis, what time is it?" A tiny Whisper model on your laptop listens for the phrase ([details](docs/wake-word.md)). After Gnosis answers it keeps listening for a few seconds, so you can follow up without the wake word. Say the wake word while it's talking to interrupt it, or say "stop".

**ElevenLabs voices (optional).** For a more natural voice, or ElevenLabs' speech recognition, set `ELEVENLABS_API_KEY` as a user environment variable and set `voice.tts` and/or `voice.stt` to `elevenlabs` in `config/gnosis.yaml`. What you say after the wake word, and Gnosis's spoken replies, then go to ElevenLabs. The wake word always stays on the laptop, and if ElevenLabs can't be reached Gnosis falls back to the on-device voice.

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
| `gnosis/core/` | Orchestrator, parallel tasks and resource locks, model router, LLM client, policy gate, audit log, event bus, tool registry |
| `gnosis/memory/` | Long-term memory: facts, episodes, keyword and vector search, learning, memory map |
| `gnosis/skills/desktop/` | App finder and launcher, UI Automation (read, click, type, shortcuts), screenshot fallback, Spotify |
| `gnosis/voice/` | Microphone and speaker, wake word, end-of-speech detection, speech-to-text, text-to-speech, voice ID, the voice loop |
| `gnosis/skills/` | Tools Gnosis can use: built-ins, memory, desktop, tasks, scheduler, phone, coder, teach mode |
| `gnosis/teach/` | Teach mode recorder, and saved skills as SKILL.md files |
| `gnosis/coder/` | The coding sandbox (WSL2 distro, or a workspace folder) |
| `gnosis/phone/` | Phone pairing and device tokens, Web Push, Android control over ADB |
| `gnosis/server/` | Local FastAPI + WebSocket API, and the phone bridge |
| `web/dashboard/` | Dashboard |
| `web/phone/` | Phone companion app (installable web app) |
| `config/` | Settings, model routing and policy |
| `deploy/` | Hosted demo: Docker Compose with Caddy for HTTPS, and the Nebius setup guide |
| `docs/architecture.md` | Full design for Gnosis v1 |
| `docs/demo-script.md` | The demo video, scene by scene |

## License

Apache-2.0
