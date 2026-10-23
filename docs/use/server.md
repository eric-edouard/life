# Run Life on a server

How-to: run Life, the voice server and the speech service on a rented Linux box, reached from the internet through a
Cloudflare Tunnel and administered over Tailscale. It is optional: Life.app runs the same things on your Mac. A server
keeps them running when the Mac sleeps. It costs the box (an OVHcloud VPS-2: 4 vCPU, 8 GB, Ubuntu 24.04), a Cloudflare
domain, and a bucket for the backup.

```text
internet ── Cloudflare ── tunnel ─┬─ life   (Life: memory, connector, nightly)
                                  └─ voice  (the voice server) ── speech (models, no storage)
you ── Tailscale ── SSH to the box
```

No port on the box is open to the internet. The tunnel dials out to Cloudflare; you reach the box only from your
tailnet.

## What you need first

1. The box, with Ubuntu 24.04, and its root SSH access for the first login.
2. A Cloudflare Tunnel and its token, with two public hostnames: `life.<your domain>` → `http://life:46200` and
   `voice.<your domain>` → `http://voice:3000`.
3. An R2 (or any S3) bucket and a key that can read and write it, and two restic passwords, one for Life's
   repository and one for the voice server's. Keep both in your password manager: without them the backup can't be
   read.
4. The keys the apps take: an OpenRouter key for Life, an ElevenLabs key for the voice server.

## Set it up

1. Log in to the box as root, and get Life's code (the repository is private: add the box's key as a read-only deploy
   key first):

   ```sh
   ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519 && cat ~/.ssh/id_ed25519.pub
   git clone git@github.com:eric-edouard/life.git /opt/life
   ```

2. Run the installer. It installs Docker and Tailscale, prints a Tailscale sign-in link (open it to add the box to
   your tailnet), closes every port but the tailnet's, and creates the secrets files in `/etc/life`, readable by root
   only:

   ```sh
   /opt/life/deploy/install.sh
   ```

   It stops and names the files to fill in. From now on, log in over the tailnet: `ssh root@life`.
3. Fill in each file in `/etc/life` (`nano /etc/life/voice.env`). Every line says what goes in it. Use the same
   `IDENTITY_SECRET` in `voice.env` and `speech.env`.
4. Run the installer again. It builds and starts everything, which takes about ten minutes the first time:

   ```sh
   /opt/life/deploy/install.sh
   ```

5. Check that all four are `healthy`:

   ```sh
   docker compose -f /opt/life/deploy/compose.yaml ps
   ```

Then open `https://voice.<your domain>/health`: it answers `{"ok":true}`.

## Update

```sh
/opt/life/deploy/update.sh
```

It pulls `main`, rebuilds what changed and restarts it. A container that fails its health check shows as
`unhealthy` in `ps`; its log says why: `docker compose -f /opt/life/deploy/compose.yaml logs --tail 100 voice`.

## Where things are

| What | Where on the box |
|---|---|
| Life's memory, state and archive | `/srv/life/life` |
| The voice server's archive and audio | `/srv/life/voice` |
| Secrets | `/etc/life/*.env` (mode 0600) |
| The code | `/opt/life` |

## Backups

Each app backs itself up once a day with restic, encrypted, to its own repository in the bucket: Life's at
`…/life-server-backup/life` (its `backup` setting), the voice server's at `…/life-server-backup/voice`
(`RESTIC_REPOSITORY` in `voice.env`). On Sundays each also prunes old snapshots and reads 5% back.

To restore the voice server on a new box, after the setup above and before its first start (`import` refuses an
archive that already holds conversations):

```sh
cd /opt/life/deploy && docker compose stop voice
docker compose run --rm voice sh -c 'restic restore latest --tag daily --target /data/restore &&
  bun apps/voice/src/index.ts import /data/restore/data/restic-staging && rm -rf /data/restore'
docker compose up -d voice
```

The import checks every file against the export's list before it writes anything. Life restores the same way from its own repository: [Back up and restore](backup.md#restore).
