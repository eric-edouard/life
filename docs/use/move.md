# Move to a new Mac

How-to: take your Life, with its memory and its archive of deleted messages, to another Mac. Only one Mac should run
your Life at a time: two would read the same sources twice and hand your agent every request twice.

## On the old Mac

1. Open Life's settings and press **Export everything…**. Pick a folder on a drive the new Mac can read.
   The export holds your memory, Life's state, the archive and a list of every file with its checksum. It holds no
   secrets; the list names the ones you will give again.
2. Quit Life from its menu, and turn off **Open Life at login**, so it doesn't start again.

## On the new Mac

1. Build and open Life as in the [README](../README.md#install).
2. Instead of **Start Life**, press **Import an export…** and pick the export folder. Life checks every file against the
   list, copies everything in, and counts it again. It refuses to import over an install that has already started.
3. Allow Life in Full Disk Access again. Your settings came with the export; check the sources you want are on.
4. Give the secrets again: the API key if you use one, the lifelog token.
5. Under **Reaching Life**, press the same button as before. The new Mac has a new Tailscale name, so
   [update the connector's address](connect.md) in Claude or ChatGPT and pair them again.

A message deleted for everyone while neither Mac's Life is running is not kept, so keep the gap between the two short.
The first night on the new Mac reads the last 7 days again.

Next: [set up a backup](backup.md) on the new Mac, if you had one.
