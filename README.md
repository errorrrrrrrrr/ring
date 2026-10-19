# ring

A small, self-hostable webring for artists' posts, federated over ActivityPub. Each member has a
public wall at `/@name`; friends, named rings of 3 to 6 members, stamps and comments work across
Ring servers, and Mastodon and other fediverse software can follow a wall.

## Run it

Node 24 or newer.

```sh
npm install
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))") \
ADMIN_EMAIL=you@example.com npm start
```

Without a mail provider, outside production, mail goes to the server log and
`data/mail-outbox.jsonl`: sign up with `ADMIN_EMAIL` (no invite needed for the first account),
then open the confirm link from there.

```sh
npm run build      # the composer: app/ into app-dist/ (gitignored); the server serves it at /app
npm run typecheck  # tsc, strict, over app/
npm test           # builds first (pretest), then node --test 'test/*.test.js'
npm run lint       # Biome; the gate is errors only
```

`npm start` needs a built `app-dist/` for `/app`; without one, `/app` answers a page saying to
run the build.

## Environment

Every setting is in `.env.example` with its default and meaning (spec 15.3). Ring reads
`process.env` only, once, in `lib/config.js`.

| Var | Default | Meaning |
|---|---|---|
| `PUBLIC_ORIGIN` | the request origin, in development | required in production, https; permanent once federated |
| `SESSION_SECRET` | | required; 32+ characters with real entropy in production |
| `ADMIN_EMAIL` | | the first account's email (no invite, becomes admin); required in production |
| `DATA_DIR` | `./data` | the one data directory |
| `PORT` | `3000` | |
| `TRUST_PROXY` | off | required in production: the proxy's address (`loopback`, a CIDR list) or a hop count (`1`) |
| `SIGNUP` | `invite` | `open` lets anyone sign up |
| `INVITES_PER_MEMBER` | `5` | live invites each |
| `FEDERATION` | `off` | `on` mounts the AP routes and starts delivery; needs an https `PUBLIC_ORIGIN` on a domain you keep forever (never `*.onrender.com`, a tunnel or an IP) |
| `AUTHORIZED_FETCH` | `1` | outboxes, collections and posts answer only signed GETs; `0` serves them unsigned |
| `MAIL_PROVIDER` | `log` outside production | `smtp` · `resend` (both need `PUBLIC_ORIGIN`) · `log` (outbox kept 24 h); unset in production, signup and reset answer 503 |
| `SMTP_URL` · `RESEND_API_KEY` · `MAIL_FROM` | | per provider |
| `NODE_NAME` | the host | the server's name in NodeInfo |
| `MEMBER_STORAGE_MB` | `500` | image storage per member |
| `NODE_ENV` | | `production`: Secure cookies, required settings enforced |

## Backups

```sh
node scripts/backup.js --data /path/to/DATA_DIR --out /safe/place
```

Writes `ring-<YYYYMMDD>T<HHMMSS>Z.tar.gz` (0600) of the data dir minus `sessions/`,
`fed/media/` (refetched on demand), `backups/`, the `.lock` lease, write temps and any earlier
backup tar. It never overwrites an existing file, and refuses an `--out` inside the data dir
(symlinks and other spellings included) other than its own `backups/`. A stopped server gives a
fully consistent tar; on a live one it is consistent per account index (each index is read before
the files it names, so every row has its file). A file it cannot read fails the run; only a file
removed meanwhile is skipped. The script prints only the path, the file count and the size.

**The tar is a secret: keep it like a password.** It holds every password hash, email and
signing key, the mail outbox (`mail-outbox.jsonl`, written when mail is set to `log`: its live
account-confirm and password-reset links work for whoever holds them until they expire) and the
invite codes in plain text (`invites.json`, each one a way in until it is used, revoked or
expires).

Restore: stop the server, then as the user the server runs as,
`tar --no-same-owner -xzf ring-....tar.gz -C <empty DATA_DIR>` (the tar records owner 0; if you
extract as root, `chown -R <server user> <DATA_DIR>` after), and start it with the same
`PUBLIC_ORIGIN` (a server that has federated refuses any other, spec 15.2). Members sign in
again (sessions are not in the tar). Details: `docs/SPEC.md` 15.4.

A member's own export (posts, settings, images, friends and follows, `following.csv` for
Mastodon) is self-serve in Settings › Account (spec 12).

## License

ring is free software under the [GNU Affero General Public License v3.0 or later](LICENSE).
If you run a modified version for other people, the AGPL asks you to offer them its source.
