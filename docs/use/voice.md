# Set up voice

How-to: add your recorded conversations to Life. Voice is optional; everything else works without it.

Voice comes from the voice server, Life's half that records your conversations through your phone, transcribes them,
tells the speakers apart and keeps where you were. Life reads it through its API, on the same machine or another. Life
keeps short quotes, not transcripts, with one exception: what you ask your agent out loud is kept word for word (up to
50,000 characters), so the agent gets your exact request. Life reads the words themselves: the voice server's own
summaries are off unless you turn them on in the phone's settings, and Life never reads them.

With voice on, Life also gets:

- what was said in conversations, searchable word for word;
- where you were, from the places the voice server saw you stay;
- "hey Life", which marks a moment in a conversation as one to remember;
- "hey" and your agent's name, which hands what you say next to [your agent](agent.md).

## In the app

1. On the voice server, create a device token for Life.
2. Open Life's settings. Under **Sources**, turn on **Pendant**, Life's name for the voice source.
3. Fill in **voice server address** (for example `https://voice.your-domain.example`) and **voice server token**, then
   press **Save**. The token goes to the Keychain, and Life restarts its services to read the new settings.

Open the status window: the **Watcher** card says when Life last heard from the voice server. Conversations show up in
answers after the next pass, at 13:00, 19:00 or overnight.

## From a checkout

`settings set` replaces the whole `sources` list, so name every source you want on, the ones already on included:

```sh
bun life settings set '{"voice":{"url":"https://voice.your-domain.example"},"sources":["voice","imessage","mail","notes"]}'
echo 'VOICE_TOKEN=<the token>' >> .env
```

`bun life settings` shows the current list. Restart the watcher afterwards. A checkout set up before the voice rename has `LIFELOG_TOKEN` in its `.env`: rename it
`VOICE_TOKEN` (Life.app moves its Keychain item itself).

Next: [set up your agent](agent.md).
