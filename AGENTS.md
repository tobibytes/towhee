# Towhee

Towhee is a self-hosted realtime collaboration engine, a Liveblocks replacement: presence and cursors, Yjs shared state, comments and threads, history and notifications. MIT. It runs on Cloudflare (Durable Objects) and on Node/Docker from one core.

Read `docs/PLAN.md` and `docs/SESSIONS.md` before starting work. The plan is the source of truth. If the code needs to differ from it, change the plan in the same PR and say why.

## Rules

- Work in session order (`docs/SESSIONS.md`). One session is one branch and one PR. Don't start a session before the one before it is merged, and don't do parts of later sessions early.
- Never commit to `main`. Open PRs with `--base main`.
- Commit as `Oluwatobi Olajide <olola73@morgan.edu>`. No AI co-author trailers.
- Before pushing: `pnpm install && pnpm lint && pnpm build && pnpm typecheck && pnpm test`.
- Add a changeset (`pnpm changeset`) when a published package changes.
- Packages keep `"private": true` until session 12, so merges don't try to publish to an npm org that doesn't exist yet. Until then, no changesets.
- Releases (from session 12): merge to `main`, then merge the "chore: version packages" PR. GitHub publishes through npm Trusted Publishing. Never publish by hand and never add npm tokens.
- Don't add services, SDKs or vendors that aren't in the plan (no Liveblocks, no hosted pub/sub). Ask first.
- Don't deploy anything, create cloud resources or set secrets. Tobi does that.
- Don't change Junco from this repo. Junco work (session 10 onward) happens in the Junco repo, under its own rules.

## Code

- TypeScript strict, ESM only, Node 22.18 or newer.
- `@towhee/protocol`, `@towhee/auth` and `@towhee/core` use only web-standard APIs (WebCrypto, `Uint8Array`, `TextEncoder`), never `node:*` or Cloudflare globals. Host-specific code lives in `@towhee/node` and `@towhee/cloudflare`.
- Treat everything from the network as untrusted: validate sizes, types and ids before use.
- Every feature gets tests. Storage implementations all pass the shared storage suite. Behavior that both hosts have is tested on both.
- Packages that must run everywhere (`protocol`, `auth`, `core`, `client`) run their tests twice through Vitest projects: in Node and in workerd (`@cloudflare/vitest-plugin`, no `nodejs_compat`). Copy `packages/protocol/vitest.config.ts`.
- Biome for linting (`biome.jsonc`, lint only). Suppress a rule only with `// biome-ignore lint/<group>/<rule>: <reason>`.
- Comments explain why, not what. Match the surrounding code.

## Commands

```bash
pnpm install
pnpm build        # every package
pnpm test         # vitest
pnpm typecheck
pnpm lint         # biome
pnpm changeset    # record a version bump
```
