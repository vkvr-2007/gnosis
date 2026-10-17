# PLAN.md: Gnosis v2 (combined build)

Gnosis lives in `C:\education\projects\gnosis` and `vkvr-2007/gnosis`, branch `v2`: v1's tested code plus
the v2 work. The owner-facing plan is the "Gnosis v2 build plan" doc in the project. Work one step at a
time; a step is done only when the owner says "pass" after its test. Don't start the next step early or
add features that aren't listed.

Every step: build with tests → pytest, `gnosis accept --desktop`, `gnosis bench` on the laptop, exact
numbers reported → owner's test → fix until pass (each failure gets a test) → log the step below.

Speed targets (bench, first words / full answer): chat 1.5 / 3 s · one tool 3 / 4 s · memory 3 / 4 s ·
two tools 4.5 / 6 s · voice, from the owner stopping talking to Gnosis speaking: 2.5 s.

Private requests stay on the local model (owner's choice): anything marked Private, the rest of a task
after read_file / read_screen / phone_notifications, and sensitive memories. Never fall back to the cloud.

## Steps
- [x] **1. App shell and brain.** Own window + tray + single instance + Diagnostics, streaming, skills,
  thinking off, claim check. Passed by the owner on 17 Oct (fa75139).
- [ ] **2. ElevenLabs voice and the face.**
  - Ctrl+Space push-to-talk from anywhere in Windows, alongside "Hey Gnosis".
  - End of speech from silence plus the words: a sentence ending in "and", "the", "to" or a trailing
    comma waits up to ~1.6 s more; a finished sentence ends at once; never longer than 6 s.
  - ElevenLabs Scribe for speech-to-text (language forced to English); ElevenLabs Flash v2.5 streamed for
    speech, sentence by sentence, with the next sentence's audio fetched while the current one plays.
  - Barge-in: talking over Gnosis (or the wake word, "stop", "wait") stops speech at once. Gnosis ignores
    its own voice through the speakers (a transcript mostly matching what it's saying is dropped), but
    "stop" and "wait" always get through.
  - One short line ("On it", "Checking") when a tool starts, only before the answer begins.
  - If ElevenLabs refuses (bad key, no credits), switch to the Windows voice for the rest of the session
    and say so once, on screen and in Diagnostics. Same for hearing: fall back to the on-device recogniser.
  - The face in the app window: sleeping, listening, thinking, working, speaking, driven by voice and task
    events. Gnosis's own design (no AYRA art).
  - Every turn logs wake time, transcript, end-of-speech time, first-speech time, answer, and why any
    transcript was dropped, all shown in Diagnostics.
  - *Owner test:* 20 spoken requests, ≥19 heard right; talking over a reply stops it 10/10; with the
    ElevenLabs key renamed Gnosis still hears and answers; speech starts within 2.5 s of the owner finishing.
- [ ] **3. Tools, gate, audit.** Every tool classified in policy.yaml with a test (click_element allowed,
  risky buttons ask); the current time put into every question so even the local model gets it right;
  reminders that pop up when the window is hidden; a web search card; the honesty check for every phrasing
  seen so far. *Owner test:* each tool 10× right; risky actions always ask; Deny stops them.
- [ ] **4. Parallel tasks.** Task cards with their own Stop; one mouse-and-keyboard lock; errors stay in
  their task. *Owner test:* three requests at once, 10 rounds, zero errors; stop one, the others finish.
- [ ] **5. Memory.** Saves only on "remember" or confirmation; recall, forget, memory list.
  *Owner test:* 10 facts survive a restart; no junk.
- [ ] **6. Wake word.** "Hey Gnosis" tuned: one-breath questions, ~10 s follow-up without the wake word.
  *Owner test:* 20 wake-ups ≤1 miss; ≤1 false wake an hour.
- [ ] **7. Desktop control, three locks.** Bring the target window forward before typing; Spotify actually
  plays; banner; Esc/"stop" kill switch. *Owner test:* each task 10×; kill switch 10/10.
- [ ] **8. Installer and demo.** Gnosis-Setup.exe; Nebius switch tested; demo script; video.
