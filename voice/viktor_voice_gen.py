"""Generate VIKTOR voice candidates with Chatterbox Turbo (runs on the laptop, not in CI).
Usage: python voice/viktor_voice_gen.py voice/refs/ref-liam-teen3.wav
Outputs land in voice/samples-out/ and peak GPU memory is printed for verification."""
import os, sys
import torch
import torchaudio as ta
from chatterbox.tts_turbo import ChatterboxTurboTTS

HERE = os.path.dirname(os.path.abspath(__file__))
ref = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "refs", "ref-liam-24k.wav")
device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"device={device}")
if device == "cuda":
    torch.cuda.reset_peak_memory_stats()
model = ChatterboxTurboTTS.from_pretrained(device=device)

ref_name = os.path.splitext(os.path.basename(ref))[0]
lines = [
    "Yo, I'm up! What are we doing today?",
    "Ha! Okay, that actually worked. [chuckle] What's next?",
    "Hmm, give me a sec... yeah, got it. Opening that now.",
]
outdir = os.path.join(HERE, "samples-out", ref_name)
os.makedirs(outdir, exist_ok=True)
for i, text in enumerate(lines):
    wav = model.generate(text, audio_prompt_path=ref)
    out = os.path.join(outdir, f"viktor-{i+1}.wav")
    ta.save(out, wav, model.sr)
    print("wrote", out)
if device == "cuda":
    print(f"peak_gpu_memory={torch.cuda.max_memory_allocated()/1e9:.2f} GB")
