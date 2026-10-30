# VIKTOR voice (Chatterbox Turbo) - laptop setup

Everything installs to D:. Hermes's own Python/config is never touched.

1. `py -0p` - need a Python 3.10-3.12. If none: `winget install astral-sh.uv`, then
   `setx UV_PYTHON_INSTALL_DIR "D:\viktor-voice\python"`, `setx UV_CACHE_DIR "D:\viktor-voice\uv-cache"`,
   `setx HF_HOME "D:\viktor-voice\hf"`, reopen terminal, `uv python install 3.12`.
2. `uv venv D:\viktor-voice\venv --python 3.12` (or `py -3.12 -m venv D:\viktor-voice\venv` if 3.12 exists)
3. `D:\viktor-voice\venv\Scripts\activate`
4. `uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu126`
   (or `pip install ...`; use `cu121` if cu126 fails; CPU fallback: plain `pip install torch torchaudio`, slower)
5. `uv pip install chatterbox-tts` (verified against 0.1.7)
6. From the repo root: `python voice/viktor_voice_gen.py voice/refs/ref-liam-teen3-24k.wav`
   then the same with ref-puck-teen4-24k.wav (and ref-liam.wav / ref-puck.wav for a slightly older tone).
   First run downloads ~4 GB of model weights to HF_HOME (D:). Outputs: voice/samples-out/.
   The script prints peak GPU memory; report it back.

Notes: Chatterbox Turbo is MIT; references are synthetic (Kokoro, Apache-2.0), pitch-shifted, no real person.
Output carries Resemble's inaudible PerTh watermark automatically.
