# PLAN.md: Gnosis v2 build plan

The owner-facing version of this plan is the "Gnosis v2 build plan" doc in the project. This file is the
copy every session works from. Follow it exactly; don't add steps or features that aren't here.

## Where it lives and who does what
- Laptop folder: `C:\education\projects\gnosis`, the one home for Gnosis (owner, 17 Oct). The old
  copy under `signalguard` is left as it is, never deleted.
- Repository: only `vkvr-2007/gnosis`. v2 is built on the `v2-app` branch and replaces `main` once
  step 1 passes the owner's test; v1 is kept under a `v1` tag.
- The cloud session writes the code and tests and pushes each step. The laptop session only pulls each
  step into the new folder, runs pytest, `scripts/smoke.py` and `scripts/bench.py`, and reports exact
  output. It doesn't write features. The owner does the hands-on test and says "pass".
- Keys are Windows user environment variables only (`NVIDIA_API_KEY`, `ELEVENLABS_API_KEY`,
  `NEBIUS_API_KEY`). Never in files, chat or logs.

## Every step
Branch `step-N-name` → automated tests → laptop: tests, smoke, bench → owner's test → fix until it
passes (each failure gets a test) → merge to `main`, log in PROGRESS.md → next step.

## Speed targets (bench on the laptop; a step that misses one isn't done)
| Request | First words | Full answer |
|---|---|---|
| Plain chat | 1.5 s | 3 s |
| One tool ("what time is it?") | 3 s | 4 s |
| Memory question | 3 s | 4 s |
| Two tools | 4.5 s | 6 s |
| Voice: you stop talking → Gnosis speaks | 2.5 s | – |

## Defaults
- Provider: NVIDIA API now; Nebius Token Factory (required for the final demo) is a settings switch,
  tested before step 8.
- Proven old code (wake word, Windows app control, ElevenLabs) is copied in at its step and re-tested;
  the rest is written fresh.
- Clicking a button by name is allowed; risky buttons (Send, Buy, Pay, Delete) always ask.
- Scope: steps 0–8 only. Phone app, coding agent, teach mode, hosted demo come back after step 8.

## Steps
- [ ] **0. New project.** Rule files, pyproject, settings and identity files, pytest, smoke and
  bench, a laptop setup script (clone into `C:\education\projects\gnosis`, venv, Start-menu shortcut).
  *Test (laptop session):* pytest passes; `python -m gnosis --check` says the model is ready.
- [ ] **1. App shell and brain** (built). Window + tray, streamed chat with Nemotron Super (thinking
  off), Stop, conversation on disk, start-up model check, diagnostics (D), single instance.
  *Owner test:* open from the Start menu, 10 questions all answered, close to tray and reopen, quit and
  restart: the conversation is still there. Bench meets the chat target.
- [ ] **2. ElevenLabs voice and the face.** Ctrl+Space; open mic with local voice detection; end of
  speech from silence plus words; Scribe; sentence-by-sentence ElevenLabs Flash speech with the next
  sentence prepared; barge-in; echo filter ("stop"/"wait" always heard); "On it" lines; Windows voice
  fallback; face states (sleeping, listening, thinking, working, speaking). Reuse v1's ElevenLabs code.
  *Owner test:* 19/20 heard right; barge-in 10/10; works with the ElevenLabs key renamed; speech within
  2.5 s.
- [ ] **3. Tools, gate, audit.** Time, open/close app, reminders (pop up when hidden), web search card.
  Tools grouped into skills (only needed ones sent). Default-deny gate with every tool classified and
  tested; Allow/Deny cards. Honesty check: an answer claiming an action with no tool run gets nudged to
  call the tool ("I've saved", "is now recorded", "is open and ready", "is closed", "Noted."). Audit log.
  Model checked on three tool-calling cases at start-up.
  *Owner test:* each tool 10× right; risky actions always ask and Deny stops them; audit log complete.
- [ ] **4. Parallel tasks.** Task cards with state and their own Stop; one mouse-and-keyboard lock;
  errors stay in their task. Automated: 100 rounds of three random fake tasks, no crossed answers.
  *Owner test:* reminder + open Spotify + a question at once, 10 rounds, zero errors; stop one, others
  finish.
- [ ] **5. Memory.** Saves only on "remember" or confirmation; recall, forget, memory list. Sensitive
  facts (health, money, addresses, IDs) never sent to the cloud, shown on screen by Gnosis itself.
  *Owner test:* 10 facts survive a restart; no junk in the list.
- [ ] **6. Wake word "Hey Gnosis".** Whisper tiny on the laptop, gated by voice detection, matching
  sound-alikes ("Hey Nosis"); one-breath questions; ~10 s follow-up without the wake word. Reuse the
  matcher tested on the laptop.
  *Owner test:* 20 wake-ups, ≤1 miss; ≤1 false wake in an hour; 5 one-breath questions answered.
- [ ] **7. Desktop control, three locks.** Per-app controls first: Notepad (new tab, type, save),
  Spotify (search and actually play), window switching; screen clicking only as a fallback. Always bring
  the target window forward and confirm it before typing or clicking. Locks: fixed rules → quick model
  check against the owner's "don't do" list → Allow for risky. Typing into a document with existing
  text asks. "Gnosis is driving" banner; Esc or "stop" ends it. Reuse v1's app control and typing guard.
  *Owner test:* each task 10× right, Spotify plays; typing guard asks every time; kill switch 10/10.
- [ ] **8. Installer and demo.** Gnosis-Setup.exe (PyInstaller + Inno Setup), Start menu, optional
  start with Windows; Nebius switch tested; demo script; README for judges.
  *Owner test:* install on a fresh Windows account; the demo runs three times; video recorded.
