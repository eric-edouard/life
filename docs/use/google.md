# Use your own Google client

How-to: sign Life in to Google with an OAuth client of your own, when the build you have carries none or when you'd
rather it used yours. Optional, and free: it needs a Google Cloud project of yours.

Life reads Gmail, your Google calendars and your Google Contacts through `gog`, and gog needs two things: a password
for the keyring it keeps your tokens in, which Life makes at the first sign-in, and a Desktop OAuth client. In a
Google Cloud project of yours, create one (APIs & Services, then Credentials, then OAuth client ID, of the type
Desktop app) and download its JSON. Store it under Life's own client name, then sign each account in:

```sh
gog auth credentials set ~/Downloads/client_secret_....json --client life
bun life connect-google you@example.com
```

`connect-google` opens Google's consent page in your browser and asks for Gmail (read and send), Calendar, Tasks and
Contacts (read only). The token gog keeps stays on this Mac. Run it again for each account Life should read.

An install that used gog before Life did signs each account in again with `bun life connect-google <address>`: Life's
gog calls now use the `life` client, and gog keeps each client's tokens apart.

A build that carries a client of its own stores that one instead, and a client you stored under `life` stays as it
is. Neither is ever printed.
