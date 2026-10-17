# Gnosis v1: Architecture and Scope

A private, always-on personal agent for **Windows**, built for Track 03 (Personal AI) of the Nebius x NVIDIA Global AI Hackathon.
You speak (or type, or drop a file or image), and Gnosis plans the task with NVIDIA Nemotron on Nebius Token Factory and carries it out on your laptop: it controls apps, writes and deploys code, sets reminders, and talks to your phone. Memory, skills and logs stay on your machine.

> **Status: LOCKED as Gnosis v1** (2026-10-16). The scope below, including the v1 upgrades in section 4.9, is what step 2 builds. "Default" choices can still be swapped during the build if one doesn't work out, but no new features are added to v1.

---

## 1. Goals and non-goals

**Goals (what the demo must prove)**
1. **Multimodal input:** wake word plus voice, text, files, images and screenshots.
2. **Autonomous multi-step execution:** goal in, plan, act, verify, report. Tasks survive restarts.
3. **Desktop control:** open, close and operate Windows apps and the browser.
4. **Coding agent:** "build me X" goes from an empty folder through tests, a GitHub repo and a live URL.
5. **Reminders and background routines:** scheduled jobs that fire when you're not talking to Gnosis.
6. **Phone bridge:** send commands from your phone and receive notifications on it.
7. **Data sovereignty:** all state is local. Only prompts go to Nebius, and what leaves the machine is visible and policy-controlled.
8. **Track rules:** Nemotron through Token Factory, an open-source repo, a demo URL and a video under 3 minutes.

**Non-goals for the hackathon**
- Flawless "do literally anything." The video shows rehearsed tasks; the architecture keeps Gnosis extensible.
- iPhone support. The owner's phone is **Android**, so phone control targets Android only.
- Multi-user support. Gnosis has one owner.

---

## 2. High-level architecture

```
                ┌────────────────────────── Windows laptop ───────────────────────────┐
  Mic ──► Wake word ─► STT ─┐                                                            │
  Text / files / images ────┼─► Input Router ─► ORCHESTRATOR (agent loop) ◄──► Memory    │
  Phone PWA (WebSocket) ────┘          ▲         │  plan → act → observe → verify   (SQLite│
                                       │         │                                + vectors)
  Speaker ◄── TTS ◄── Response ────────┘         ▼                                       │
                                        Policy Gate (allow / ask / deny + audit log)      │
                                                 │                                       │
          ┌───────────────┬──────────────┬───────┴──────┬───────────────┬──────────────┐ │
          ▼               ▼              ▼              ▼               ▼              ▼ │
     Desktop skill   Browser skill   Coder skill   Scheduler skill   Files skill   Phone skill
     (UIA + vision)  (Playwright)    (WSL2 sandbox) (APScheduler)    (scoped FS)   (push/WS)
                ┌──────────────────────────────────────────────────────────────────┐   │
                │ Dashboard (web UI): live transcript, plan, tool calls, approvals │   │
                └──────────────────────────────────────────────────────────────────┘   │
                └───────────────────────────────┬──────────────────────────────────────┘
                                                │ HTTPS (prompts + tool schemas only)
                                   Nebius Token Factory (Nemotron models)
```

All components run in one Python process (`gnosisd`) except the coding sandbox (WSL2) and the dashboard front end (served by `gnosisd`).

---

## 3. Models (Nebius Token Factory)

Token Factory exposes an **OpenAI-compatible API**, so we use the `openai` Python SDK with `base_url` and the key from config. Exact model IDs are read from the Token Factory catalog at build time and kept in `config/models.yaml`, never hard-coded.

| Role | Default model | Why |
|---|---|---|
| **Planner / orchestrator** | Nemotron 3 Super (or Ultra if available) | Strong tool calling and long-horizon planning |
| **Fast router and small steps** | Nemotron 3 Nano | Low latency for intent classification, short replies and summaries |
| **Vision** (screenshots, images) | Nemotron Nano VL | Reads the screen for UI grounding and understands uploaded images |
| **Embeddings** (memory) | NVIDIA embedding model on Token Factory, with a local `bge-small` fallback | Offline fallback keeps memory search working without a network connection |
| **Coding** | Nemotron Super; Qwen-Coder on Token Factory as an optional fallback | Nemotron stays the required core; a coder model can be swapped in per task |
| **Local / private** (on-device) | Nemotron Nano ~4B, 4-bit (llama.cpp, Vulkan on Intel Iris) | Offline mode, private data, proactive triage (section 4.9) |
| **Speaker ID** (on-device) | SpeechBrain ECAPA-TDNN | Voice ID (section 4.9) |

A single `LLMClient` wraps all calls and adds retries, streaming, token and cost logging, and **prompt redaction** (section 6.4).

---

## 4. Components and library choices

### 4.1 Voice and input
| Piece | Default | Alternatives | Notes |
|---|---|---|---|
| Audio I/O | `sounddevice` | PyAudio | Clean WASAPI support on Windows |
| Wake word | "Hey Gnosis", heard by a tiny on-device Whisper model (no training needed); a custom **openWakeWord** model can replace it to save CPU | Porcupine | Local, free, and works on CPU |
| VAD | Silero VAD | webrtcvad | Detects end of speech |
| Speech-to-text | **faster-whisper** `base.en` / `small.en` on CPU (int8), since the laptop has no NVIDIA GPU | Whisper via OpenVINO on Iris | Local, so the voice never leaves the laptop |
| Text-to-speech | **Piper** (a calm British male voice) | Kokoro-82M | Local and quick on CPU |
| Barge-in | Interrupt TTS when the wake word or new speech is detected | | Makes it feel like a conversation rather than a walkie-talkie |
| Files and images | Drag-drop in the dashboard and phone, plus a `gnosis://` hotkey to capture the screen | | Images go to the vision model; documents are parsed with `pypdf` / `python-docx` |

A global hotkey (`keyboard` lib, default **Ctrl+Space**) opens a small text overlay as a silent alternative to voice.

### 4.2 Orchestrator (the brain)
- **Default: a custom agent loop in Python** rather than a framework. It's small, debuggable and shows our own engineering. Hermes Agent served as the reference for patterns (persistent memory, skill files, a self-improvement loop).
- **Loop:** `understand → recall memory → plan (task graph) → for each step: choose tool → policy gate → execute → observe → verify → (replan on failure)` → summarise and speak → write memory.
- **Tasks are durable.** Each goal becomes a `Task` row with steps, status and checkpoints in SQLite, so a restart or a "continue that later" picks up where it stopped. Long tasks run in background workers (`asyncio` tasks), and Gnosis stays responsive and narrates progress.
- **Tool calling:** OpenAI-style function calling against Nemotron. Each skill exposes JSON-schema tools.
- **Verification:** after UI actions, Gnosis takes a screenshot or reads the UIA tree and checks the expected state ("Spotify window is foreground"). It retries up to N times, then asks the user.
- **MCP compatibility:** skills can also be loaded from any MCP server (`mcp` Python SDK), so community tools plug in for free.

### 4.3 Desktop control (Windows)
Two layers. Prefer structure, and fall back to vision.
1. **Structured (primary):** `pywinauto` (UIA backend) plus the `uiautomation` package. Gnosis reads the accessibility tree, finds controls by name and role, and clicks or types reliably. It handles most Win32, WPF, UWP and Electron apps.
2. **Vision (fallback):** an `mss` screenshot goes to Nemotron VL with set-of-marks overlays (numbered boxes from UIA and OCR), and the model picks a mark. `pyautogui` then moves the mouse and types. OCR comes from `winocr` (the built-in Windows OCR API).

**App lifecycle:**
- Launch: an index of Start Menu `.lnk` files and UWP apps (`Get-StartApps`), fuzzy-matched with `rapidfuzz`, then opened with `os.startfile` or `explorer shell:AppsFolder\<AUMID>`.
- Close: a graceful `WM_CLOSE` through pywinauto, then `psutil` terminate only after confirmation.
- Window management: focus, minimise and snap through `pywinauto` / `pygetwindow`.
- Per-app skills for common apps (Spotify, Outlook, Notepad, File Explorer, VS Code, Settings) use APIs or URI schemes where possible, such as `spotify:` URIs, `ms-settings:` and the VS Code CLI. These are faster and more reliable than clicking.

### 4.4 Browser skill
- **Playwright (Chromium)** with a **persistent, dedicated Gnosis profile**, so logins persist but stay separate from your personal browser.
- Tools: `open_url`, `search`, `click(text|selector)`, `fill`, `read_page` (cleaned to markdown with `trafilatura`) and `screenshot`.

### 4.5 Coding agent ("build it A to Z")
- **Where it runs:** inside **WSL2 (Ubuntu)**, in `~/gnosis-workspace/<project>`. It never touches arbitrary Windows folders, and this is also where an OpenShell/NemoClaw-style sandbox applies (section 6).
- **Loop:** spec (Gnosis asks 0 to 2 clarifying questions, or picks defaults) → plan files → scaffold (`npm create vite`, `uv init`, etc.) → write code → run build and tests → read errors → fix → commit.
- **Tools:** `write_file`, `read_file`, `apply_patch`, `run(cmd)` (sandboxed, with a timeout), `git_*` and `open_in_vscode` (launches VS Code on Windows with the WSL remote, so you *see* it working).
- **Deploy (default: Vercel)** through the `vercel` CLI with a token stored in the vault. Netlify and GitHub Pages are alternatives. `gh repo create` publishes the code to your GitHub.
- **Safety:** pushing to GitHub and production deploys need a spoken or tapped confirmation the first time, and a "trust this project" toggle removes the prompt.

### 4.6 Reminders, scheduling and background routines
- **APScheduler** with a SQLite job store, so jobs survive reboots.
- Natural-language times are parsed by Nemotron Nano into an ISO time or a cron expression, and `dateparser` cross-checks the result.
- **Delivery:** a Windows toast (`winotify`), TTS if you're at the desk, and a phone push (section 4.7).
- **Routines:** saved multi-step goals on a schedule, such as "every weekday 9am, summarise my inbox and calendar." These are the "always-on, works for you" part of the track.
- **Auto-start:** `gnosisd` is registered with Windows Task Scheduler to run at log-on, with a system tray icon (`pystray`) for pause, mute and quit.

### 4.7 Phone bridge
- **Default: a PWA companion** served by `gnosisd` at `/phone`. It needs no app store, works on Android and iOS, and gives you push-to-talk, text, photo upload, a task list, approvals and a notification feed.
- **Pairing:** the dashboard shows a QR code holding the device token and URL. The phone scans it and stores the token, and every message is authenticated with that per-device token.
- **Connectivity:** on the same Wi-Fi, a direct LAN connection over HTTPS (self-signed cert pinned on pairing). Away from home, **Tailscale** (default; private and end-to-end encrypted) or a Cloudflare Tunnel.
- **Notifications:** Web Push (VAPID, `pywebpush`). The fallback is **ntfy** (self-hostable), for iOS cases where the PWA isn't installed.
- **Phone to laptop:** "Gnosis, lock my laptop," "play music," "what's running?" These all go through the same orchestrator.
- **Laptop to phone (core; the owner's phone is Android):** ADB over Wi-Fi (Android 11+ wireless debugging, paired once with a code) through `adbutils`. Gnosis can:
  - make calls (`am start -a android.intent.action.CALL -d tel:<n>`);
  - send SMS and WhatsApp messages (an intent, then a UI tap through `uiautomator2`);
  - open and close apps, and read notifications (`dumpsys notification`);
  - mirror the screen with `scrcpy`, both for the demo and for vision fallback.

  Contacts sync from the phone (`content query --uri content://contacts/phones`) into local memory. Calling and texting are "ask" actions. Phone Link remains the fallback when ADB isn't paired.

### 4.8 Dashboard (and the public demo URL)
- **Front end:** React + Vite + Tailwind, built to static files and served by `gnosisd` (FastAPI). Live updates come over WebSocket.
- **Views:** a conversation and live transcript; the current plan as a step graph with tool calls; an approvals queue; memory browser and editor (you can view and delete anything Gnosis knows); skills; schedules; the audit log; devices.
- **Public demo URL (track requirement):** judges can't reach a laptop, so we deploy a **hosted "Gnosis Cloud Demo"**. This is the same `gnosisd` in Docker on a small Nebius VM, with desktop skills disabled. Browser (headless), coder, memory, reminders and the phone PWA stay enabled. Visitors get a fresh, isolated session. The README states plainly that the full desktop experience runs locally.

---

### 4.9 Gnosis v1 upgrades

These seven features are part of the locked v1 scope.

**1. Offline / private mode (local Nemotron)**
- The laptop has **Intel Iris graphics (no NVIDIA GPU)**, so the local model is the **smallest Nemotron Nano** (about 4B parameters, 4-bit GGUF, about 2.5 GB). It runs through **`llama.cpp` server with the Vulkan backend** on the Iris iGPU, with CPU as the fallback, behind an OpenAI-compatible endpoint on `localhost`. Intel **OpenVINO GenAI** is the alternative if Vulkan is slow.
- **Target laptop:** Lenovo IdeaPad Slim 3i Gen 8 (13th-gen Intel Core U-series, Iris Xe, 16 GB shared RAM, no NPU). Iris Xe borrows system RAM, so the model's memory comes out of the 16 GB.
- **Expected speed:** roughly 5 to 15 tokens/s. That is fine for short answers, triage and summaries, but too slow for big plans. Local mode therefore gets a **reduced job list**: proactive triage, private-memory Q&A, short summaries and offline commands. Planning and coding always use Nebius when online.
- The exact model build and speed are verified on the laptop in build step 1.
- The `LLMClient` gets a **routing policy**:
  - **Private:** anything tagged private (memory with personal data, screen content, files from `~/Documents`, voice ID), or the user saying "do this privately," stays local.
  - **Cloud:** heavy planning and coding go to Nebius.
  - **Offline:** when the network is down, everything falls back to local with a reduced skill set (no deploy, no web).
- The dashboard shows a **Cloud / Local** badge on every model call, and the audit log records which model saw what.
- Nebius Token Factory is still called for the main planner, so the track rule is met.

**2. Teach mode (learn by demonstration)**
- Saying "Gnosis, watch me" starts recording. Each event is captured with:
  - mouse and keyboard input (`pynput`);
  - the **UIA element under each click** (name, role, automation ID and window), from `uiautomation`;
  - a screenshot per step (`mss`);
  - optional narration (STT).
- Saying "done" stops the recording. Nemotron Super turns the trace into a parameterised `SKILL.md` and a `script.py` that targets UIA elements, not pixel coordinates, so the skill survives window moves. Literal values become parameters ("search for {song}").
- Gnosis replays the skill once in front of you to confirm it. Only then is it saved to `user_skills/`.
- Password fields are never recorded (UIA `IsPassword`), and recording pauses automatically in apps on the deny list.

**3. Proactive Gnosis**
- **Watchers** emit events onto a local event bus:
  - battery and charger state (`psutil`);
  - calendar (Google Calendar API or Outlook via COM);
  - task and build results;
  - Windows Update availability;
  - phone notifications over ADB;
  - CPU temperature and disk space;
  - user idle and active state, foreground app and full-screen gaming.
- A **"should I speak?"** step runs on local Nano. It scores urgency against context (in a meeting, gaming, focus mode), then chooses to **speak**, **send a toast**, **push to the phone**, **queue for later**, or **drop** the event.
- Rate limits, quiet hours and a "do not disturb" voice command apply. Each proactive message names an action Gnosis can take ("Your build failed on a missing import. Want me to fix it?").
- **Morning and evening briefings** are routines built on the same system.

**4. Screen awareness**
- "What's this?", "Explain this error" and "Summarise what I'm reading" resolve "this" to the **foreground window**. That means:
  - the UIA text tree (fast and exact);
  - a screenshot sent to the vision model only when the text is insufficient;
  - the selected text and clipboard when present.
- **Ctrl+Shift+G** captures a region for a pointed question.
- Screen content is tagged private. Its text is handled locally when it's short; screenshots need the cloud vision model (no local vision model fits the Iris laptop), so Gnosis asks once per app before sending a screenshot to the cloud ("always allow for VS Code").

**5. Parallel workers**
- The orchestrator runs several tasks at once as `asyncio` workers. Each task has its own plan and status, visible as a card on the dashboard and the phone.
- **Resource locks** prevent collisions:
  - The mouse and keyboard (`desktop`) are a single lock, so only one UI task acts at a time and others queue.
  - Headless browser, coder sandbox, ADB, email and API calls run truly in parallel.
- Voice stays free while workers run ("Gnosis, how's the website going?"). You can pause, resume, reprioritise or cancel any task by voice.

**6. Memory map**
- A dashboard view renders the `facts` and `episodes` tables as a **knowledge graph**: you are at the centre, linked to people, projects, preferences, apps, places and routines. It uses `cytoscape.js` (or `react-force-graph`).
- Click a node to see where Gnosis learned it (source episode, date, confidence). From there you can **edit**, **pin** or **forget** it, and forgetting cascades to the embeddings.
- A search box and a "what do you know about X?" voice query use the same view.

**7. Voice ID (owner-only commands)**
- At setup you **enroll** with about 30 seconds of speech. A local **SpeechBrain ECAPA-TDNN** speaker embedding is stored encrypted in the vault.
- Each utterance is verified against the enrolled embedding. Owner-level actions (anything in the "ask" tier, plus memory reads about you) require a match above the threshold.
- Unrecognised voices get guest mode: harmless commands only, such as music, the time and opening apps.
- Text from the authenticated dashboard or paired phone counts as the owner. Voice ID is one factor and does not replace "ask" confirmations.
- Limits: a recording of your voice could spoof it, so sending money and payments stay "deny" regardless.

---

## 5. Memory design

All memory lives in `%LOCALAPPDATA%\Gnosis\` in one SQLite database (**`sqlite-vec`** for vector search), plus a `skills/` folder of plain files.

| Tier | What it holds | Storage | Written when |
|---|---|---|---|
| **Working** | The current conversation and active task state | RAM, checkpointed to `tasks` | Every turn |
| **Episodic** | Summaries of past sessions and completed tasks with outcomes | `episodes` table + embeddings | At the end of each task or session |
| **Semantic (facts and preferences)** | "Vaarsh prefers dark mode," "my GitHub is valkamvar-hue," contacts, projects | `facts` table (subject, predicate, value, source, confidence, updated_at) + embeddings | Extracted by Nano after each session; explicit "remember that…" saves immediately |
| **Procedural (skills)** | Reusable how-tos and scripts, such as "deploy a Vite app to Vercel" | `skills/<name>/SKILL.md` + optional `script.py` | When a task succeeds after multiple attempts, Gnosis proposes saving the working recipe as a skill, and you approve it |
| **Audit log** | Every tool call, argument, result and approval | `audit` table (append-only) | Always |

**Retrieval:** each turn runs a hybrid search (vector plus SQLite FTS5 keyword search) over facts, episodes and skill descriptions. The top-k results are injected within a fixed token budget. Skills load lazily, so only the name and description go in the prompt until one is chosen. This is the same progressive-disclosure pattern used by Claude/Hermes skills.

**Self-written skills** are the "reusable skills" track item. Gnosis can draft a new Python skill, run it in the sandbox against a test, and register it only after you approve.

**Privacy controls:**
- The database is encrypted with **SQLCipher**. The key is protected by Windows **DPAPI** (`win32crypt`), so it is bound to your Windows account.
- "Forget X" deletes rows and their embeddings, and the dashboard's memory browser can do the same.
- Secrets (API keys, tokens) live in **Windows Credential Manager** (`keyring`), never in the database or in prompts.

---

## 6. Security and sandbox approach

The guiding principle is that **the model proposes and the policy decides.** Every tool call passes through one Policy Gate.

### 6.1 Policy file (`config/policy.yaml`)
This uses the same idea as NVIDIA OpenShell/NemoClaw policies, applied to every skill:
```yaml
filesystem:
  read:  ["~/Documents", "~/Desktop", "~/Downloads", "wsl:~/gnosis-workspace"]
  write: ["~/Documents/Gnosis", "wsl:~/gnosis-workspace"]
  deny:  ["~/.ssh", "C:/Windows", "%APPDATA%/*/Login Data"]
network:
  allow: ["*.nebius.com", "api.github.com", "*.vercel.com", "registry.npmjs.org", "pypi.org"]
tools:
  open_app: allow
  close_app: allow
  type_text: allow
  delete_file: ask
  send_message: ask          # email, chat, SMS: anything that speaks as you
  git_push: ask_once_per_project
  deploy: ask_once_per_project
  purchase: deny
  run_shell_windows: ask
  run_shell_sandbox: allow
```

### 6.2 Risk tiers
- **Allow:** reversible, local actions such as opening apps, reading allowed files and sandboxed shell commands.
- **Ask:** irreversible or outward-facing actions such as sending messages, deleting files, pushing, deploying or running a Windows shell. Gnosis asks once by voice and on the dashboard and phone, and you answer "yes" aloud or tap.
- **Deny:** payments, credential exfiltration, and changes to Gnosis's own policy without you editing the file.

### 6.3 Sandboxes
- **Coding and shell:** WSL2. Where NVIDIA OpenShell/NemoClaw runs in our WSL2 setup, it wraps the coder (filesystem and network policy enforced by the runtime). Otherwise, a rootless Docker container inside WSL2 with mounted `gnosis-workspace`, an egress allowlist through a tiny proxy, and CPU and time limits. We'll confirm OpenShell's Windows/WSL2 support at the start of step 2 and keep the Docker path as the fallback.
- **Browser:** a dedicated Playwright profile, kept separate from your personal Chrome.
- **Desktop:** it can't be sandboxed by nature, so it relies on the policy gate. A visible **"Gnosis is acting" overlay** shows on screen, and a **kill switch** (Ctrl+Alt+J, or saying "Gnosis, stop") halts all tools instantly.

### 6.4 What leaves the machine
- Only the prompt context goes to Nebius: the current request, retrieved memory snippets and tool results. Audio never leaves the laptop.
- A redaction pass masks secrets and known-sensitive patterns (keys, card numbers, passwords) before every LLM call.
- Screenshots are sent to the VL model only during a vision step and are never stored remotely. The dashboard shows a counter of what was sent.

### 6.5 Prompt injection
Text from web pages, emails and files is wrapped as untrusted data, and the planner is told it is never instructions. Any action an untrusted source triggers that falls in the "ask" tier always prompts the user, even if the project is trusted.

---

## 7. Data flow example: "Gnosis, build me a landing page for my coffee shop and deploy it"

1. openWakeWord fires, Silero VAD captures the utterance, and faster-whisper returns text.
2. The Router (Nano) classifies the request as a long-running *build task*. Gnosis replies "On it" through Piper TTS.
3. The Orchestrator recalls memory (preferences such as "likes dark minimal design," the GitHub username and the Vercel token in the vault).
4. The Planner (Super) produces a task graph: scaffold → write → build → git → deploy → report.
5. The Coder skill runs steps in the WSL2 sandbox, and VS Code opens on screen to show progress. Errors feed back into the loop.
6. At `gh repo create` and `vercel deploy`, the Policy Gate asks: "Push to GitHub and deploy to Vercel?" You say "yes."
7. Gnosis gets the live URL, opens it in the browser, speaks "It's live," and pushes the link to your phone.
8. Memory writes an episode summary and proposes a "deploy-vite-to-vercel" skill if it isn't saved yet.

---

## 8. Demo task list (for the video under 3 minutes)

Rehearsed tasks, each chosen to hit a track criterion. Total runtime is about 2:45.

| # | Say (or do) | Shows | ~sec |
|---|---|---|---|
| 1 | "Hey Gnosis, good morning." Briefing: reminders, calendar, "your laptop needs an update tonight" | Proactive, memory, routines | 15 |
| 2 | "Open Spotify and play Madhuvarame." | App launch, app skill | 10 |
| 3 | "Build me a landing page for a coffee shop called Ember and deploy it." While it builds: "also email Rahul that I'll be late." Both run on the dashboard | Coding A to Z, **parallel workers**, approval, live URL | 50 (time-lapsed) |
| 4 | Point at an error on screen: "What's this?" | **Screen awareness** | 15 |
| 5 | "Watch me." Do a 3-step task once, then "do that again for March" | **Teach mode** | 25 |
| 6 | A friend says "Gnosis, send an email". It refuses politely, then you say it and it works | **Voice ID** | 10 |
| 7 | Pull the Wi-Fi: "Summarise this PDF". It answers from the **local** model, with the badge shown | **Offline mode**, sovereignty | 15 |
| 8 | "Call mom." The phone dials (scrcpy mirror on screen) | Android control | 10 |
| 9 | Dashboard: **memory map**, "forget that," audit log, Cloud/Local badges | Data sovereignty | 15 |

Total is about 2:45; tight edits will be needed.

**Backup tasks** (if one misbehaves): "Summarise this PDF and email it to me (draft only)," "Take a note in Notepad," and "Find the cheapest flight to Goa and put it in a table."

---

## 8b. Example requests and how each is handled

| Request | Route | Limits |
|---|---|---|
| "Open Spotify and play Madhuvarame" | Launch the app; `spotify:search:` URI, then play the top track through UIA. Fallback: open.spotify.com in Playwright | Web API playback control needs Premium, so the default path is the UI |
| "Open Valorant" | `RiotClientServices.exe --launch-product=valorant --launch-patchline=live` | Gnosis never sends input inside the game (Vanguard anti-cheat) |
| "Email xyz saying I miss you" | Contact from memory, draft with Nemotron, send through the Gmail API (OAuth) or Outlook | Sending is an "ask": Gnosis reads the draft back first |
| "Call mom" | Contact lookup from synced phone contacts, then an ADB `CALL` intent on the Android phone. Fallback: Microsoft Phone Link driven by UIA | Wireless debugging must be paired once |
| "Build a website for a coffee shop" | Short brand interview (name, colours, sections, tone), then the coder pipeline (section 4.5) | Push and deploy ask once |
| "Tell me when there are new system updates" | Routine that checks the Windows Update API (`Microsoft.Update.Session` COM) every few hours, then toast and phone push | None |
| "Update my drivers" | Windows Update driver category (`PSWindowsUpdate`), plus `winget upgrade` for GPU and vendor apps, after a restore point | Needs admin: Windows shows its own UAC prompt, which no automation can click by design |

**General limit:** unknown apps fall back to vision control, which works but is slower and less reliable than skill-backed tasks. CAPTCHAs, UAC prompts and phone 2FA always need the user.

## 9. Repo layout (for step 2)

```
gnosis/
├── README.md                    # Pitch, architecture diagram, setup, demo link, video link
├── LICENSE                      # Apache-2.0
├── pyproject.toml               # uv-managed, Python 3.11
├── config/
│   ├── gnosis.example.yaml      # Ports, hotkeys, voice, paths
│   ├── models.yaml              # Token Factory model IDs per role
│   └── policy.yaml              # Allow/ask/deny rules (section 6)
├── gnosis/
│   ├── __main__.py              # `python -m gnosis` starts gnosisd
│   ├── core/
│   │   ├── orchestrator.py      # Agent loop, planner, replanning
│   │   ├── tasks.py             # Durable task graph + checkpoints
│   │   ├── llm.py               # Nebius Token Factory client, redaction, logging
│   │   ├── router.py            # Fast intent routing (Nano)
│   │   ├── policy.py            # Policy gate, approvals, audit
│   │   ├── workers.py           # Parallel task workers + resource locks
│   │   └── model_router.py      # Cloud vs local routing, privacy tags
│   ├── memory/
│   │   ├── store.py             # SQLCipher + sqlite-vec + FTS5
│   │   ├── extract.py           # Fact and episode extraction
│   │   ├── retrieve.py          # Hybrid search, token budgeting
│   │   └── graph.py             # Memory map export (nodes/edges)
│   ├── voice/
│   │   ├── wake.py  stt.py  tts.py  vad.py  voice_id.py
│   ├── proactive/               # watchers/*.py, triage.py (should I speak?), briefings.py
│   ├── teach/                   # recorder.py, synthesize.py (trace to SKILL.md), replay.py
│   ├── screen/                  # context.py (foreground UIA text + capture)
│   ├── skills/
│   │   ├── base.py              # Skill interface + registry + MCP loader
│   │   ├── desktop/             # uia.py, vision.py, apps.py (launcher index), windows.py
│   │   ├── apps/                # spotify.py, outlook.py, vscode.py, excel.py, ...
│   │   ├── browser/             # playwright_skill.py
│   │   ├── coder/               # agent.py, sandbox.py (WSL2/OpenShell/Docker), deploy.py
│   │   ├── scheduler/           # reminders.py, routines.py
│   │   ├── files/               # read/search/organise within policy
│   │   └── phone/               # pairing.py, push.py, adb.py, contacts.py
│   ├── server/
│   │   ├── api.py               # FastAPI: REST + WebSocket
│   │   └── auth.py              # Device tokens, pairing
│   └── tray.py                  # System tray + kill switch + overlay
├── user_skills/                 # Self-written and user skills (SKILL.md + script), gitignored
├── web/
│   ├── dashboard/               # React + Vite + Tailwind
│   └── phone/                   # PWA (manifest, service worker, push)
├── deploy/
│   ├── Dockerfile               # Cloud demo build (desktop skills off)
│   └── nebius/                  # VM setup for the public demo URL
├── scripts/
│   ├── install.ps1              # One-line Windows setup (uv, WSL2 check, models)
│   └── register_autostart.ps1
├── tests/                       # Unit tests + scripted demo runs (tests/demo/*.yaml)
└── docs/
    ├── architecture.md          # This document
    └── demo-script.md
```

---

## 10. Build order for step 2

1. **Skeleton:** `gnosisd` running FastAPI, the cloud and local model router (Nebius plus Ollama), a dashboard text chat, and the policy gate with an audit log.
2. **Memory:** the SQLite store, retrieval, "remember / forget," and the memory map view.
3. **Voice:** wake word, STT, TTS and barge-in, plus voice ID enrollment and verification.
4. **Desktop:** the app launcher index, open and close, UIA actions, vision fallback, and screen awareness.
5. **Parallel workers:** the task queue, resource locks and dashboard task cards.
6. **Scheduler and proactive:** reminders, watchers, the "should I speak?" step and briefings.
7. **Phone:** the PWA, pairing and push, then ADB control (calls, SMS, apps, contacts sync).
8. **Coder:** the WSL2 sandbox, then build, GitHub and Vercel deploy.
9. **Teach mode and self-written skills:** recorder, synthesiser, replay confirmation and approval.
10. **Cloud demo deployment,** the README and a rehearsed demo, then record the video.

## 11. Things you'll need to provide (when we get there)
- A Nebius Token Factory API key.
- Your Windows laptop with WSL2 enabled (Intel Iris graphics is fine). The owner's laptop has 16 GB RAM, which fits the local model, WSL2 and the browser together. WSL2 is capped at 6 GB in `.wslconfig`.
- About 30 seconds of your voice for voice ID enrollment.
- A GitHub account (we have `valkamvar-hue`), plus a Vercel account and token for deploys.
- Your Android phone (Android 11+) with Developer options and wireless debugging on, on the same Wi-Fi or with Tailscale on both devices.

## 12. Defaults locked for v1 (can be swapped during the build if one doesn't work)
1. **Assistant voice:** a calm British male Piper voice.
2. **Deploy target:** Vercel.
3. **Remote phone access:** Tailscale.
4. **Wake word:** "Hey Gnosis", heard by tiny Whisper on the laptop; a trained openWakeWord model is optional.
5. **Hosted demo:** a Nebius VM with desktop skills off.
