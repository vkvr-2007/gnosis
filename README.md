# Gnosis

Gnosis is a Windows desktop assistant you talk to. It thinks with NVIDIA Nemotron, will listen and speak
through ElevenLabs, and runs everyday tasks for you, a few at a time, asking before anything risky.

This is version 2, rebuilt from scratch one tested step at a time. The plan, with each step's pass test,
is in [PLAN.md](PLAN.md); the log is in [PROGRESS.md](PROGRESS.md); the rules for working on the code
are in [CLAUDE.md](CLAUDE.md). Version 1 lives on the `main` branch as a reference.

## Run it (Windows 10/11, Python 3.11+)

```powershell
py -m venv .venv
.venv\Scripts\pip install -e ".[app,dev]"
[Environment]::SetEnvironmentVariable('NVIDIA_API_KEY', '<your key>', 'User')   # once, then open a new window
.venv\Scripts\python -m gnosis --check      # is the model reachable?
.venv\Scripts\python -m gnosis --shortcut   # add Gnosis to the Start menu
.venv\Scripts\python -m gnosis              # open it
```

In the window: Enter sends, Shift+Enter starts a new line, the button turns into Stop while Gnosis is
answering, and **D** opens diagnostics. Closing the window hides it to the tray; Quit is in the tray menu.

Settings are optional: copy `config/settings.example.toml` to `config/settings.toml`. Who Gnosis is
(name, wake word, voice) is in `config/identity.json`. API keys are only ever read from environment
variables.

## Check it

```powershell
.venv\Scripts\python -m pytest            # unit tests, no network
.venv\Scripts\python scripts\smoke.py     # one real question, end to end
.venv\Scripts\python scripts\bench.py     # speed: first words, first sentence, done, for five questions
```

## Credits

Some ideas (the event protocol, speed bench, diagnostics panel, voice handling and safety gate) come from
[AYRA](https://github.com/rehanshaik123/AYRA) (MIT). Gnosis's code is its own. Licence: Apache-2.0.
