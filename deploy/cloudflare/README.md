# towhee.madebytobi.com

Tobi's Towhee deployment: the Cloudflare Worker `towhee` with room and inbox Durable Objects, on the custom domain `towhee.madebytobi.com`.

- Clients connect to `wss://towhee.madebytobi.com`.
- Health: `https://towhee.madebytobi.com/health`.
- Apps sign tokens with key id `default` and the secret stored at `~/.towhee/towhee.madebytobi.com.secret` on Tobi's machine (also set on the Worker as `TOWHEE_SECRET`). It is not in this repo.

## Deploy

```bash
pnpm install && pnpm build               # from the repo root; the Worker bundles the built packages
pnpm --filter @towhee/deploy-cloudflare deploy
```

## Check it

```bash
cd deploy/cloudflare
TOWHEE_SECRET="$(cat ~/.towhee/towhee.madebytobi.com.secret)" node smoke.mjs
```

It checks health, two clients syncing, presence, a comment thread, the mentioned user's inbox, saving and restoring a version, a late joiner, and that a bad token is refused. On a laptop, wrap it in `caffeinate -ims` so the machine doesn't sleep mid-run.
