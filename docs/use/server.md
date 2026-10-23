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
2. A Cloudflare Tunnel and its token, with two public hostnames: `life.<your domain>` → `http://localhost:46200` and
   `voice.<your domain>` → `http://voice:3000`.
3. An R2 (or any S3) bucket, a key that can read and write it, and a new restic password. Keep the password in your
   password manager: without it the backups can't be read.
4. The keys the apps take: an OpenRouter key for Life, an ElevenLabs key for the voice server.

## Set it up

1. Log in to the box as root, and get Life's code (the repository is private: add the box's key as a read-only deploy
   key first):

   ```sh
   ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519 && cat ~/.ssh/id_ed25519.pub
   git clone git@github.com:eric-edouard/life.git /opt/life
   ```

2. Run the installer. It installs Docker and Tailscale, prints a Tailscale sign-in link (open it to add the box to
   your tailnet), closes every port but the tailnet's, and creates the files for your secrets, readable by root only:

   ```sh
   /opt/life/deploy/install.sh
   ```

   It stops and names the files to fill in. From now on, log in over the tailnet: `ssh root@life`.
3. Fill in each file it names (`nano /etc/life/shared.env`); every line says what goes in it. `shared.env` holds what
   Life and the voice server share (the bucket, the restic password, your time zone), `identity.env` the secret the
   voice server and the speech service share, `voice.env` and `tunnel.env` their own, and
   `/srv/life/life/state/secrets.env` Life's keys.
4. Give Life its data and settings, once. On a new install, your name (and your emails and phone numbers, each
   repeated); to move an existing Life or voice server instead, [restore it](#restore). Then Life's address and its
   backup:

   ```sh
   cd /opt/life/deploy && docker compose build life
   docker compose run --rm --no-deps life bun apps/server/src/host/cli.ts init --name "Your Name" --email you@example.com
   docker compose run --rm --no-deps life bun apps/server/src/host/cli.ts settings set '{
     "connector": {"origin": "https://life.example.com"},
     "backup": {"repository": "s3:https://ACCOUNT_ID.r2.cloudflarestorage.com/life-server-backup/life",
                "password": "printenv RESTIC_PASSWORD"}}'
   ```

5. Run the installer again. It builds and starts everything. The first start takes about fifteen minutes: the speech
   service fetches its models (about 3 GB) before it answers.

   ```sh
   /opt/life/deploy/install.sh
   ```

6. Check that all four are `healthy`:

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
| Life's memory, state and archive | `/srv/life/life` (`owner`, `state`, `machine`) |
| The voice server's archive and audio | `/srv/life/voice` |
| The speech models | the `life_models` Docker volume |
| Secrets | `/etc/life/*.env` and Life's `/srv/life/life/state/secrets.env` (mode 0600) |
| The code | `/opt/life` |

## Backups

Each app backs itself up once a day with restic, encrypted, to its own repository in the bucket: Life's at
`…/life-server-backup/life` (its `backup` setting), the voice server's at `…/life-server-backup/voice`
(`RESTIC_REPOSITORY` in `voice.env`). On Sundays each also prunes old snapshots and reads 5% back.

### Restore

On a new box, in step 4 instead of `init`, with the files of step 3 filled in. Each import checks every file against
the export's list before it writes anything, and refuses data that is already there.

```sh
cd /opt/life/deploy
docker compose run --rm --no-deps life sh -c 'restic -r s3:https://ACCOUNT_ID.r2.cloudflarestorage.com/life-server-backup/life \
  restore latest --tag daily --target /data/restore &&
  bun apps/server/src/host/cli.ts import "$(find /data/restore -type d -name backup-staging)" && rm -rf /data/restore'
docker compose run --rm --no-deps voice sh -c 'restic restore latest --tag daily --target /data/restore &&
  bun apps/voice/src/index.ts import /data/restore/data/restic-staging && rm -rf /data/restore'
```

Then give Life its settings (step 4) and keys again: a backup holds no secrets.
