# PLAN.md: Gnosis v2

The full plan, with the architecture and the reasons, is the "Gnosis v2 plan" doc in the project.
This file tracks the steps. A step is ticked only when its test passes on the owner's laptop.

- [ ] **1. App shell and brain.** Window + tray, typed chat with Nemotron Super streaming, the event
  protocol, speed bench, smoke test, diagnostics panel (D).
  *Test:* open Gnosis from the Start menu, ask 10 questions, all answered, no crashes. Close to the tray,
  reopen, the conversation is still there. `scripts/bench.py` prints its timings (kept as the baseline).
- [ ] **2. ElevenLabs voice and the face.** Ctrl+Space, open mic with local voice detection, Scribe,
  sentence-by-sentence speech, talk over it to stop it, "On it" lines, Windows voice fallback, a face.
  *Test:* 19 of 20 requests heard right; barge-in 10/10; still works with a broken key; speech starts
  after the first sentence.
- [ ] **3. Tools, the safety gate and the audit log.** Time, open/close app, reminders, web search card;
  default-deny gate; Allow / Deny cards; only needed tools sent to the model.
  *Test:* each tool 10× in a row; risky actions always ask; a page saying "delete my files" does nothing.
- [ ] **4. Parallel tasks.** Task cards; mouse-and-keyboard tasks take turns; stopping one leaves the rest.
  *Test:* three requests at once, 10 rounds, zero errors; stop one mid-way, the others finish.
- [ ] **5. Memory.** Saves only what the owner says or confirms. *Test:* 10 facts survive a restart; no junk.
- [ ] **6. Wake word "Hey Gnosis".** One-breath questions, follow-ups without the wake word.
  *Test:* 20 wake-ups, at most one false wake an hour.
- [ ] **7. Desktop control with three locks.** Per-app controls first, banner, kill switch.
  *Test:* each task 10× in a row, Spotify really plays, kill switch 10/10.
- [ ] **8. Installer and demo.** *Test:* clean-account install; the demo runs three times.
