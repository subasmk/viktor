# cbt.py - verified low-memory Chatterbox-Turbo ONNX generator (used to make the samples Subash heard)

Verified working config (2026-10-30, 2GB-RAM Linux sandbox):
- Model: ResembleAI/chatterbox-turbo-ONNX (MIT), DTYPE = "quantized" for ALL parts
  (fp16 LM OOMs small machines; q4/q4f16 garble under these conditions - cause tentative).
- MUST sample: temperature 0.8, top_p 0.95, repetition_penalty 1.2 (matches chatterbox-tts
  0.1.7 defaults). Greedy argmax produces mumble with quantized weights.
- Reference audio MUST be 24 kHz mono (script asserts). Refs in ../refs/ are already 24k.
- Short casual lines rendered clean 4/4; longer lines may slip a word under q8.
- Env: pip venv with transformers + onnxruntime (+ soundfile, numpy, huggingface_hub).
  Avoid the tqdm pin from chatterbox-tts in the same env (breaks transformers).
- Usage: python cbt.py "line to speak" path/to/ref-24k.wav out.wav
