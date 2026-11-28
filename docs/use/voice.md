# Set up voice

How-to: add your recorded conversations to Life. Voice is optional; everything else works without it.

Voice is Life's voice layer: your phone records your conversations through the pendant, the voice server on your Mac
transcribes them, tells the speakers apart and keeps where you were, and Life turns them into voice units. Life keeps
short quotes, not transcripts, with one exception: what you ask your agent out loud is kept word for word (up to
50,000 characters), so the agent gets your exact request.
The phone app and the voice server are in this repository: [their README](../../apps/lifelog/README.md) sets them up.
This page assumes they run.

With voice on, Life also gets:

- what was said in conversations, searchable word for word;
- where you were, from the places the voice server saw you stay;
- "hey Life", which marks what you say next as one to remember and answers it as Ask Life would: your phone says "Life
  heard you", and the answer, or why Life couldn't do it, shows in the thread.

## In the app

1. Open Life's settings. Under **Voice**, paste your ElevenLabs API key and press **Start fresh** (or **Import an
   export…** to bring recordings from another Mac). Life.app runs voice on this Mac from then on, even while Life is
   closed.
2. Under **Voice summaries**, sign in to ChatGPT or save a Claude token: summaries run on that subscription.
3. Under **Sources**, turn on **Pendant**, Life's name for the voice source.
4. In Life's menu, press **Pair an app** and point your iPhone's Camera at the code: one scan pairs the phone with Life
   and with voice.

Open the status window: the **Watcher** card says when Life last heard from the voice server. A conversation's words are
searchable within minutes; its episodes and facts come after the night's run.

## From a checkout

`settings set` replaces the whole `sources` list, so name every source you want on, the ones already on included:

```sh
bun life settings set '{"lifelog":{"url":"https://lifelog.your-tailnet.ts.net"},"sources":["voice","imessage","mail","notes"]}'
echo 'LIFELOG_TOKEN=<the token>' >> .env
```

`bun life settings` shows the current list. Restart the watcher afterwards.

Next: [your agents](agent.md).
