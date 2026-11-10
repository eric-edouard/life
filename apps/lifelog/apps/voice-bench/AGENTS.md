# apps/voice-bench

Measures which speaker-embedding model, or blend of models, names the most of the owner's known voices, on his own
recordings. The winner rule is his (10 Nov 2026): the most known voices named right while at most 1 name in 100 is
wrong. What it found: `docs/research/voice-bench.md`.

## How to run it

`bun run --cwd apps/lifelog/apps/voice-bench bench <step>`, in order: `sample [count] [seed]`, `clips`,
`embed [model…]`, `score`, `page`; `all` runs clips, embed and score. Each step skips what it already wrote.

- `sample` reads the archive read-only (`src/archive.ts`, through the voice eval's `exportVoices`): `DATABASE_PATH`
  and `AUDIO_DIR` as Lifelog Host's `server.env` sets them. It takes every turn he answered and a seeded draw of the
  others, for the review. `clips` needs `ffmpeg`.
- `embed` needs `uv` (`local/embed.py`). Every model is pinned in its `MODELS` (code commit, weights revision) and
  downloads on first use; a new pin embeds again. It runs one worker per core: about ten minutes a model for 6,000
  clips. `score` takes seconds.
- `page` serves the report on 127.0.0.1 (`VOICE_BENCH_PORT` to choose the port): the cloud, the models, and the
  review. Stop it when done.
- Everything it writes holds the owner's voice or words: it lives in `~/Life/docs/lifelog/voice-bench/`
  (`VOICE_BENCH_DIR` to move it), never in the repo. `report.md` there has numbers only.

## Worth knowing

- Who spoke a turn is decided when scoring (`src/truth.ts`): his answer in the bench's review, else his answer in
  the archive, by the server's own rule (`answers`, `speakerOf`). The sample stores no truth.
- Profiles and ranking are the server's (`profilesWithout`, `rankPeople`): a turn is judged against profiles built
  without the evidence of its own conversations, as the voice eval does. The bench has no profile code of its own.
- No server threshold is used. The bench sweeps its own score threshold and lead, so models whose scores sit in
  different ranges compare fairly.
- "Nobody I know" is mostly a voice he does not care about: never a known voice, and a name given to it is a wrong
  name. "Several voices" and "not a person" leave the scoring.
- A blend is the mean of the models' z-scored likenesses (`blendOf`). "Fuse" is rank fusion, another thing
  (`core/fusion.ts`).
- The review's answers go to `answers.jsonl` in the bench's folder, append-only, the latest per turn. They never
  reach the archive: lifelog's naming is his to change in the app (`docs/decisions.md`).
- The cloud is drawn by the server's `src/voices/cloud.js`, shared with lifelog's voice map; its positions are the
  server's `pcaOf`.
- A model that cannot be loaded from its authors' release is left out and named in the research note, never faked.
