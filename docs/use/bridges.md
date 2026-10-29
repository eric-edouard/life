# Send replies from Life

Life can send the reply you chose on a decision card, as you, into the chat it answers. It sends only the text you
tapped, once, and never if they wrote again after the card was made. iMessage goes through `imsg` (installed, nothing
to link; the first send may ask to let it control Messages). WhatsApp goes through a bridge: a small program
linked to your WhatsApp as one more device, like WhatsApp Web.

The bridge and its local Matrix server run on your Mac and talk to nothing else. Linking a bridge is against
WhatsApp's terms; for one personal account, bans are rare.

## Set it up

Everything lives in `~/Library/Application Support/Life/bridges/`.

1. The Matrix server, Synapse, in its own Python, with a local-only config (`server_name: life.local`, listening on
   `127.0.0.1:8008` only, the client API only, registration off, no federation, `redaction_retention_period: null`):

   ```sh
   cd ~/Library/Application\ Support/Life/bridges/synapse
   uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python matrix-synapse
   .venv/bin/python -m synapse.app.homeserver --server-name life.local --config-path homeserver.yaml --generate-config --report-stats=no
   ```

2. The WhatsApp bridge, built with Go's own crypto (no libolm):

   ```sh
   cd ~/Library/Application\ Support/Life/bridges/whatsapp
   GOBIN=$PWD go install -tags goolm go.mau.fi/mautrix-whatsapp/cmd/mautrix-whatsapp@latest
   ./mautrix-whatsapp -c config.yaml -e
   ```

   In `config.yaml`: `homeserver.address` `http://127.0.0.1:8008`, `homeserver.domain` `life.local`, the database
   `sqlite3-fk-wal` at `file:whatsapp.db?_txlock=immediate`, `appservice.address` `http://127.0.0.1:29318`,
   `bridge.permissions` `{"@owner:life.local": admin}`, `network.history_sync.max_initial_conversations` `0` (Life reads
   WhatsApp from the Mac app; the bridge only sends). Then `./mautrix-whatsapp -g -c config.yaml -r registration.yaml`,
   and add the registration's path to Synapse's `app_service_config_files`.

3. Your account on the Matrix server, and its token where Life reads it (`matrix.json` in Life's state, mode 600):

   ```sh
   .venv/bin/register_new_matrix_user -c homeserver.yaml -u owner -a http://127.0.0.1:8008
   ```

   Log in once (`POST /_matrix/client/v3/login`) and save `{"user":"@owner:life.local","token":"<access token>"}`.

4. Link WhatsApp: start the bridge, then the provisioning API's QR login (`/_matrix/provision/v3/login/start/qr` on
   port 29318, with the bridge's `provisioning.shared_secret` and `?user_id=@owner:life.local`), and scan the code from
   WhatsApp → Settings → Linked devices → Link a device.

5. Keep both running (a LaunchAgent each), and turn sends on: `bun life settings set '{"sends":true}'`.

## Check it

`bun life send <decision>` says why a reply can't go, or sends it and closes the decision. The ledger keeps one `sent`
line per send.
