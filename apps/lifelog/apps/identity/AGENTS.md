# apps/identity

The speech service (Python): audio in, numbers out, nothing stored. Speaker embeddings (SpeechBrain ECAPA) for the
voice server's recognition, and a block's speaker turns (Nemotron 3), language per turn (VoxLingua107) and words
(Parakeet Ultra) for its transcription (`docs/processing.md`, "Who transcribes"). Its endpoints are listed at
the top of `app.py`. Audio stays in memory for one request and is never written or logged. Lifelog Host ships these
files and installs and runs them on the owner's Mac (`apps/mac-quiet/README.md`); a change to `uv.lock` reaches it
with the next Host build. The server calls it when `IDENTITY_URL` and `IDENTITY_SECRET` are set
(`docs/providers.md`).

## Invariants

- **One contract, two Parakeet runtimes**, picked by the host with `SPEECH_RUNTIME` (mlx on macOS, onnx elsewhere),
  each a class with `tokens(samples)` in `PARAKEETS`. Nothing else branches on the runtime but which pinned Parakeet it downloads (`MODELS`). ONNX is fp32: every int8
  export drops up to 87% of the words (`docs/research/transcription-bench.md`).
- **Every model is pinned** to a revision in `MODELS` and loaded once per process; one worker thread runs them.
- **Routing is the lifelog server's** (`apps/server/src/route-turns.ts`): the service answers what it heard, nothing
  about Scribe.

## Running and testing

It uses `uv` with Python 3.12; torch comes from the CPU-only index on Linux. `test_contract.py` needs no models and
no dependencies, and the gate runs it with any `python3`. `test_app.py` needs the models (a made-up two-voice clip,
`fixtures/two-voices.ogg`, made with macOS `say`); run it before pushing a change to the models or their code:

```bash
cd apps/identity && uv sync
MODEL_DIR=/tmp/speech uv run python app.py download   # once; the image's MODEL_DIR is its /models volume
MODEL_DIR=/tmp/speech uv run python -m unittest -v test_app
```

In Docker: `docker build -t speech apps/identity`, then `docker run -v speech-models:/models -e IDENTITY_SECRET=…
speech` (the first start fetches about 3 GB), and the real test with `docker run --rm -v speech-models:/models speech
python -m unittest -v test_app`. `THREADS` caps torch's and onnxruntime's threads (all cores by default).

