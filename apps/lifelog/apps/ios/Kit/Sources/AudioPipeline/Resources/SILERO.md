# Silero VAD

`silero-vad-unified-v6.0.0.mlmodelc` is Silero VAD v6 (https://github.com/snakers4/silero-vad, MIT, Silero Team),
converted to Core ML by FluidInference: https://huggingface.co/FluidInference/silero-vad-coreml (MIT), fetched
2026-10-09. Inputs: `audio_input` [1, 576] (64 samples of context, then 512 new samples at 16 kHz), `hidden_state`
and `cell_state` [1, 128]. Outputs: `vad_output` [1, 1, 1] (speech probability) and the next states.
