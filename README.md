# G.N.O.S.I.S.

**Gnosis** is a personal assistant for one person, thinking with **NVIDIA Nemotron**. Press **Space**
at the laptop and talk, or say "Hey Gnosis": he answers out loud in an ElevenLabs voice, searches the
web, plays videos, works in the owner's own Chrome and Windows apps, runs PowerShell and handles
files — and asks first before spending money, sending or posting as the owner, deleting for good, or
touching passwords and security settings. The face is an animated character.

Gnosis v3 is built on [AYRA](https://github.com/rehanshaik123/AYRA) (MIT): its face, its Node bridge,
its tools, approvals, jobs and tray app are AYRA's. What changed:

- **The brain is Nemotron, not Claude.** AYRA ran Claude Code through the Claude Agent SDK.
  `bridge/sdk.mjs` stands in for that SDK with an agent loop over an OpenAI-compatible API —
  Nemotron 3 Super on NVIDIA's API, thinking off, streamed — speaking the same message protocol, so
  the rest of the bridge works unchanged. `bridge/builtins.mjs` rebuilds the Claude Code tools AYRA
  used (PowerShell, files, web search and pages) under the same names, so the gate still reviews them.
- **Web search** goes through the Tavily or Brave APIs when a key is set (`TAVILY_API_KEY`,
  `BRAVE_API_KEY`), otherwise through a Google search in Gnosis's own Chrome (`bridge/web.mjs`).
- **Private work stays on the laptop**: a request that says so ("privately…"), or a turn in which a
  tool read the owner's files or windows, runs on the on-device Nemotron Nano (llama.cpp on
  `127.0.0.1:8081`) and is blanked from what the cloud model sees later. No local model, no answer —
  never the cloud instead.
- **From Gnosis v2**: the claim check (an action answered without a tool is never spoken, and the
  model is nudged to act), `browser_play_youtube` (finds a real video and checks it's playing), and
  the "Hey Gnosis" wake word with its mishearings.
- **Gnosis himself**: a male character (short black hair, hoodie, headphones that glow while he
  works), a male voice, and friendly banter in place of AYRA's flirting.

Models and providers are in [config/models.json](config/models.json) (NVIDIA, Nebius Token Factory,
on-device); who he is, in [config/identity.json](config/identity.json).

## Run it

Needs Windows 10/11, Node.js 20+, Chrome, and `NVIDIA_API_KEY` set (a free key from build.nvidia.com).
Optional: `ELEVENLABS_API_KEY` for the voice (otherwise the browser's own speech is used),
`TAVILY_API_KEY` for faster search, and the local model for private requests.

```bash
npm install
npm run setup     # checks the machine, changes nothing
npm start         # brain + face → open http://localhost:5173, click INITIALISE, press Space
npm run shortcuts # Windows: Gnosis.exe in the tray — starts with Windows, Ctrl+Alt+A to talk
npm run bench     # five standard questions, timed
node scripts/ask.mjs "what time is it?"   # ask the running bridge from the terminal
```

Keys are environment variables (or `.env.local`), never files in the repo. In the HUD: **Space** to
talk, **Space** again to send, **Space Space** or **Esc** to stop, **D** diagnostics, **T** an audio
test, **W** hands-free, **R** researcher mode. `avatar.html?pose=talk` on the face's dev server shows
the character on his own.

## Hands-free

Press **W** in his window (or **Ctrl+Alt+W** / the tray menu from any app) and just say "Gnosis" —
from any app, his window needn't be in front. After answering he listens about 15 seconds for a
follow-up. While he listens, whatever is playing pauses, and resumes after. Sound from the laptop's
own speakers is recognised and ignored.

## Research agent

A clearly complex question — a comparison, several parts, "research …", pros and cons — goes to the
research agent: it splits the question into parts, sends a searcher and a reporter per part, and a
reviewer scores the findings and writes a cited answer with a confidence (about 40 seconds). Press
**R** for researcher mode, which sends every question to a deeper run across GitHub, Stack Overflow,
Hacker News, arXiv, Quora and the web.

## Credits & licence

MIT — see [LICENSE](LICENSE). Built on [AYRA](https://github.com/rehanshaik123/AYRA), itself based on
[JARVIS by Aditya Dewaskar](https://github.com/adewaskar/jarvis). Gnosis's character is original.
