# Set up voice

How-to: add your recorded conversations to Life. Voice is optional; everything else works without it.

Voice comes from lifelog, a companion project that records your conversations on your phone, transcribes them, tells
the speakers apart and keeps where you were. lifelog runs its own server, and Life reads it through lifelog's API. Life
keeps short quotes, not transcripts, with one exception: what you ask your agent out loud is kept word for word (up to
50,000 characters), so the agent gets your exact request.
lifelog lives in this repository: [its README](../../apps/lifelog/README.md) sets it up. This page assumes it runs.

With voice on, Life also gets:

- what was said in conversations, searchable word for word;
- where you were, from the places lifelog saw you stay;
- "hey Life", which marks what you say next as one to remember and answers it as Ask Life would: your phone says "Life
  heard you", and the answer, or why Life couldn't do it, shows in the thread.

## In the app

1. Open Life's settings. Under **Voice**, paste your ElevenLabs API key and press **Start fresh** (or **Import an
   export…** to bring recordings from another Mac). Life.app runs voice on this Mac from then on, even while Life is
   closed.
2. Under **Voice summaries**, sign in to ChatGPT or save a Claude token: summaries run on that subscription.
3. Under **Sources**, turn on **Pendant**, Life's name for the lifelog source.
4. In Life's menu, press **Pair an app** and point your iPhone's Camera at the code: one scan pairs the phone with Life
   and with voice.

Open the status window: the **Watcher** card says when Life last heard from lifelog. A conversation's words are
searchable within minutes; its episodes and facts come after the night's run.

## From a checkout

`settings set` replaces the whole `sources` list, so name every source you want on, the ones already on included:

```sh
bun life settings set '{"lifelog":{"url":"https://lifelog.your-tailnet.ts.net"},"sources":["lifelog","imessage","mail","notes"]}'
echo 'LIFELOG_TOKEN=<the token>' >> .env
```

`bun life settings` shows the current list. Restart the watcher afterwards.

Next: [your agents](agent.md).
