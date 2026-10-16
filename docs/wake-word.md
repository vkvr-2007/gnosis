# Training the "Hey Gnosis" wake word

Gnosis listens for its wake word with [openWakeWord](https://github.com/dscripka/openWakeWord), on your laptop.
Until a custom model exists, it uses the bundled **"Hey Jarvis"** model, so that's the phrase to say.

## Make a "Hey Gnosis" model

openWakeWord trains wake words from synthetic speech, so you don't need to record hundreds of samples yourself.

1. Open openWakeWord's automatic training notebook (linked from its README, "Training New Models") in Google Colab.
2. Set the target phrase to `hey gnosis`. Add a couple of spellings that sound the same, such as `hey nosis`, to help it generalise.
3. Run all cells. Training can take an hour or more on a free Colab GPU and produces `hey_gnosis.onnx`.
4. Copy the file to `%USERPROFILE%\.gnosis\models\hey_gnosis.onnx` and set it in `config/gnosis.yaml`:

   ```yaml
   voice:
     wake_model: ~/.gnosis/models/hey_gnosis.onnx
   ```

5. Restart with `python -m gnosis serve --voice`.

## Tuning

- If it wakes up by accident, raise `voice.wake_threshold` (for example 0.6 or 0.7).
- If it misses you, lower it (for example 0.4).
- Test in the room where you'll record the demo, with the fan or AC on.
