# towhee.madebytobi.com

Tobi's Towhee deployment: the Cloudflare Worker `towhee` with room and inbox Durable Objects, on the custom domain `towhee.madebytobi.com`.

- Clients connect to `wss://towhee.madebytobi.com`.
- Health: `https://towhee.madebytobi.com/health`.
- It also serves the site (`apps/site`: landing page, docs, examples) and the live demo at `/demo`.
- Keys are the Worker secret `TOWHEE_KEYS`: `default` (apps sign with it; secret at `~/.towhee/towhee.madebytobi.com.secret` on Tobi's machine) and `demo` (only `demo:*` rooms; used by `/demo/token`; secret at `~/.towhee/towhee-demo.secret`). Neither is in this repo.

## Run it locally

```bash
pnpm install && pnpm build               # from the repo root; builds the packages and the site
cd deploy/cloudflare
cp .dev.vars.example .dev.vars           # throwaway local keys
pnpm exec wrangler dev                   # http://localhost:8787 (site), /demo (board)
```

For live reload on the site, also run `pnpm --filter @towhee/site dev` (port 5173, proxies to 8787).

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
