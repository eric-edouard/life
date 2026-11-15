# Set up voice

How-to: add your recorded conversations to Life. Voice is optional; everything else works without it.

Voice comes from lifelog, a companion project that records your conversations on your phone, transcribes them, tells
the speakers apart and keeps where you were. lifelog runs its own server, and Life reads it through lifelog's API. Life
keeps short quotes, not transcripts, with one exception: what you ask your agent out loud is kept word for word (up to
50,000 characters), so the agent gets your exact request. lifelog is not public yet, so this page assumes you already
run it.

With voice on, Life also gets:

- what was said in conversations, searchable word for word;
- where you were, from the places lifelog saw you stay;
- "hey" and your agent's name, which hands what you say next to [your agent](agent.md) and marks it as one to
  remember;
- "hey Life", which marks what you say next as one to remember, without asking anyone to act.

## In the app

1. In lifelog, create a device token for Life.
2. Open Life's settings. Under **Sources**, turn on **Pendant**, Life's name for the lifelog source.
3. Fill in **lifelog address** (for example `https://lifelog.your-tailnet.ts.net`) and **lifelog token**, then press
   **Save**. The token goes to the Keychain, and Life restarts its services to read the new settings.

Open the status window: the **Watcher** card says when Life last heard from lifelog. A conversation's words are
searchable within minutes; its episodes and facts come after the night's run.

## From a checkout

`settings set` replaces the whole `sources` list, so name every source you want on, the ones already on included:

```sh
bun life settings set '{"lifelog":{"url":"https://lifelog.your-tailnet.ts.net"},"sources":["lifelog","imessage","mail","notes"]}'
echo 'LIFELOG_TOKEN=<the token>' >> .env
```

`bun life settings` shows the current list. Restart the watcher afterwards.

Next: [set up your agent](agent.md).
