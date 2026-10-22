# Set up voice

How-to: add your recorded conversations to Life. Voice is optional; everything else works without it.

Voice comes from lifelog, a companion project that records your conversations on your phone, transcribes them, tells
the speakers apart and keeps where you were. lifelog runs its own server; Life reads it through lifelog's API and never
keeps the transcripts, only short quotes. lifelog is not public yet, so this page assumes you already run it.

With voice on, Life also gets:

- what was said in conversations, searchable word for word;
- where you were (`places`), from lifelog's location stays;
- "hey Life", which marks a moment in a conversation as one to remember;
- "hey" and your agent's name, which hands what you say next to [your agent](agent.md).

## In the app

1. In lifelog, create a device token for Life.
2. Open Life's settings. Under Sources, turn on **Pendant**.
3. Fill in lifelog's address (for example `https://lifelog.your-tailnet.ts.net`) and the token, then press **Save**.
   The token goes to the Keychain; Life restarts its services to read the new settings.

Open the status window: the Watcher card says when Life last heard from lifelog. Conversations show up in answers after
the next midday or nightly pass.

## From a checkout

```sh
bun life settings set '{"lifelog":{"url":"https://lifelog.your-tailnet.ts.net"}}'
echo 'LIFELOG_TOKEN=<the token>' >> .env
```

Add `lifelog` to the `sources` setting the same way, then restart the watcher.

Next: [set up your agent](agent.md).
