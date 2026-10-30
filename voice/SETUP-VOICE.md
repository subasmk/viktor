# VIKTOR voice - D-drive setup (matches the auditioned voice exactly)

One command from the repo folder (or give Hermes the prompt from the team chat):

    powershell -ExecutionPolicy Bypass -File voice\setup-voice.ps1

What it does (and ONLY this):
- Finds Python 3.10-3.12 via the py launcher, or bootstraps uv + Python 3.12 into D:\viktor-voice
  (standalone zip, no installer, no admin, no C: writes). Hermes's own Python 3.14.9 is never touched.
- Creates D:\viktor-voice\venv and installs: onnxruntime, transformers, soundfile, numpy, huggingface_hub.
- Downloads the quantized Chatterbox-Turbo ONNX files (~1.2 GB) into D:\viktor-voice\hf.
- Renders 3 audition samples with YOUR selected voice (voice/selected-voice.json -> refs/ref-liam-24k.wav)
  into D:\viktor-voice\samples, then writes D:\viktor-voice\READY.
- Needs ~3 GB free on D:. No GPU, no torch, no CUDA: this is the exact engine + config (quantized,
  temp 0.8, top_p 0.95, rep-penalty 1.2) that generated the voice sample you picked.

Every cache lives under D:\viktor-voice (pip cache, HF cache, uv cache, samples, say output).
Nothing writes to C:. If anything can't proceed, the script prints STOP with the reason.

After READY exists, the VIKTOR watcher (mascot click) speaks replies with this voice automatically.
First reply loads the model (~1 min one time), then keeps it warm. If the selected voice is missing or fails, the watcher shows the error
(engine:error in its state + log) and stays silent - it never silently substitutes
another voice or engine. Relax that later by editing voice/voice_config.json to "auto".

To uninstall: delete D:\viktor-voice. Done.
