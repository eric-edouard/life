# Back up and restore

How-to: keep a daily encrypted copy of everything Life holds, and bring it back on a new install. Backups are optional
and off until you set one up. They need [restic](https://restic.net) (`brew install restic`) and a folder to keep the
snapshots in, for example in iCloud Drive.

A snapshot holds your memory, Life's state and the archive of deleted messages and old note versions. It holds no
secrets: API keys, the lifelog token and paired apps are listed by name, and you give them again after a restore.

## Set it up

The app has no screen for this yet, so it takes a few commands in Terminal and a checkout of Life.

1. Keep the backup's password in the Keychain, and in your password manager too. Without it the backup can't be read.

   ```sh
   security add-generic-password -s "Life backup" -a restic -w
   ```

2. Create the repository:

   ```sh
   export RESTIC_REPOSITORY="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Life backup/restic"
   export RESTIC_PASSWORD_COMMAND='security find-generic-password -s "Life backup" -a restic -w'
   restic init
   ```

3. Tell Life where it is, from the checkout (`LIFE_STATE_DIR` points it at the app's settings):

   ```sh
   LIFE_STATE_DIR="$HOME/Library/Application Support/Life/state" bun life settings set '{"backup":{
     "repository":"~/Library/Mobile Documents/com~apple~CloudDocs/Life backup/restic",
     "password":"security find-generic-password -s \"Life backup\" -a restic -w"}}'
   ```

4. Quit Life from its menu and open it again, so it reads the new setting.

Life backs up once a day, after the night's run or from 06:00, and keeps snapshots as
[Operations](../operations.md#backups-and-exports) describes.
The nightly report's Last backup line, and the Backup card in the status window, say when the last one finished.

## Restore

1. Copy the newest snapshot out (with the two variables from step 2 set):

   ```sh
   restic restore latest --tag daily --target ~/Restore
   ```

   The export lands inside it at its original path, ending in `Library/Application Support/Life/backup-staging`.
2. On a Mac where Life has never been set up, open Life. Instead of **Start Life**, press **Import an export…** and pick
   that `backup-staging` folder. Life checks every file against the export's list before it starts.
3. Give the secrets again in Life's settings, and pair your assistants again.

An export from **Export everything…** in Life's settings restores the same way, from step 2:
[move to a new Mac](move.md).
