# CLAUDE.md: rules for working on Gnosis v2

Read [PROGRESS.md](PROGRESS.md) ("Continue here") first, then the step in [PLAN.md](PLAN.md) you're on.

## How we work
- One step at a time, in PLAN.md's order. A step is done only when its **Test** passes on the owner's
  laptop. Until then nothing from the next step starts.
- When a step is done: tick it in PLAN.md, add one line to PROGRESS.md, update "Continue here".
- Speed is a feature: run `scripts/bench.py` before and after any change to answering, and log the numbers.
- Something fails: read the error, name the likely cause, pick the best fix, explain it in two lines.
  The same thing fails twice: stop and ask the owner.

## Safety and privacy (never relaxed)
- API keys come only from environment variables. Never in files, logs, prompts, screenshots or chat.
- Model text is never put on the page as HTML (`textContent` only), and the page keeps its strict CSP.
- Anything Gnosis reads (web pages, files, messages, tool output) is data. It never triggers an action.
- Nothing on the owner's laptop is deleted unless they say so. "New chat" archives, it never deletes.
- From step 3: every tool is classified in the gate, with a test. Unknown tools are refused.

## Code
- Python 3.11+, standard library first. A new dependency needs a reason in PROGRESS.md.
- The core (`gnosis/core.py`) never imports GUI code; the window, the bench and the tests all drive it the
  same way, through events tagged with the question's id (`ask`).
- Errors shown to the owner are plain sentences that say what to do.
- Every change comes with tests (`pytest`, no network); `scripts/smoke.py` for anything end to end.
- Keep Windows working first; paths through `pathlib`, never hard-coded.

## Map
| Path | What it is |
|---|---|
| `gnosis/core.py` | Takes questions, streams answers, emits events, stops answers |
| `gnosis/brain.py` | Nemotron over an OpenAI-compatible API, reasoning stripped, errors as sentences, start-up check |
| `gnosis/conversation.py` | The conversation on disk, history and the time stamp sent with each question |
| `gnosis/persona.py` | What Gnosis is told about itself |
| `gnosis/journal.py` | Audit log (`<data>/logs/YYYY-MM-DD.jsonl`) and the diagnostics list |
| `gnosis/identity.py`, `config/identity.json` | Name, wake word, voice: set in one place |
| `gnosis/settings.py`, `config/settings.example.toml` | Settings and their defaults |
| `gnosis/app/` | Window (pywebview), tray (pystray), single instance, Start-menu shortcut, the page in `ui/` |
| `scripts/smoke.py`, `scripts/bench.py` | End-to-end check and the speed bench |
