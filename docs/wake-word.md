# The "Hey Gnosis" wake word

Gnosis wakes up when you say **"Hey Gnosis"**. Everything happens on your laptop: nothing is sent
anywhere until it has heard the phrase.

## How it hears you

When you speak while Gnosis is idle, it transcribes that short clip with a tiny Whisper model
(`tiny.en`, about 75 MB) and checks whether it starts with "Hey Gnosis". Whisper often spells the
name the way it sounds ("Hey Nosis", "Hey Noses"), and those count too. It takes about 0.6 s per clip
on an Intel i5, and in testing noise, a fan, music and "Hey Jarvis" never woke it.

You can say the request in the same breath: "Hey Gnosis, what time is it?" is answered straight away.
Or say "Hey Gnosis", wait for the chime, then speak.

## Settings (`config/gnosis.yaml`, under `voice:`)

- `wake_stt_model: tiny.en` is the Whisper model that listens for the phrase. `base.en` is more
  accurate in a noisy room but uses more CPU.
- `wake_model: null` keeps the phrase detector. Set it to an openWakeWord `.onnx` file to use a
  trained model instead (below).

## Optional: a trained openWakeWord model

A trained model uses less CPU than transcribing, which helps if Gnosis listens all day on battery.

1. Open openWakeWord's automatic training notebook (linked from its README, "Training New Models")
   in Google Colab.
2. Set the target phrase to `hey gnosis`, plus a spelling that sounds the same such as `hey nosis`.
3. Run all cells. Training takes an hour or more on a free Colab GPU and produces `hey_gnosis.onnx`.
4. Copy it to `%USERPROFILE%\.gnosis\models\hey_gnosis.onnx` and set
   `wake_model: ~/.gnosis/models/hey_gnosis.onnx`.
5. Restart with `python -m gnosis serve --voice`. With a model, `wake_threshold` tunes it: raise it
   (0.6–0.7) if it wakes by accident, lower it (0.4) if it misses you.
