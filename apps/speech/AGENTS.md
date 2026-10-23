# apps/speech

An optional Python service (SpeechBrain ECAPA, CPU): voice excerpts in, embeddings out. Voice Host ships these
files and installs and runs them on the owner's Mac (`apps/dictation/README.md`); a change to `uv.lock` reaches it with
the next Host build. The server calls it when
`IDENTITY_URL` and `IDENTITY_SECRET` are set (`docs/voice/providers.md`). Its endpoints are listed at
the top of `app.py`. Audio stays in memory for one request and is never written or logged.

It uses `uv` with Python 3.12, and torch comes from the CPU-only index set in `pyproject.toml`. The gate only
byte-compiles the files; the real test needs the model and runs in the Docker build. Run it yourself before pushing:

```bash
cd apps/speech && uv sync
MODEL_DIR=/tmp/ecapa uv run python app.py download   # once; the default MODEL_DIR is the image's
MODEL_DIR=/tmp/ecapa uv run python -m unittest -v
```
