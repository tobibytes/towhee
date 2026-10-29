# Releasing

Packages: `@towhee/protocol`, `auth`, `core`, `client`, `node`, `cloudflare`, `react`. The server image: `ghcr.io/tobibytes/towhee`.

## How a release happens

1. Changes that affect a package come with a changeset (`pnpm changeset`).
2. On `main`, the Release workflow opens or updates a "chore: version packages" PR.
3. Merging that PR runs `pnpm release` (`scripts/publish.ts`): every version not yet on npm is published with npm Trusted Publishing (no token) and provenance, tagged, and given a GitHub Release.
4. If `@towhee/node` was published, the same workflow builds the Docker image for amd64 and arm64 and pushes `ghcr.io/tobibytes/towhee:<version>` and `:latest`.

`node scripts/publish.ts --dry-run` packs everything and lists what would publish.

## The first release (v0.1), once

A trusted publisher can only be added to a package that already exists, so the first version goes out by hand.

1. **npm org:** create the `towhee` organization on npmjs.com (the `@towhee` scope).
2. **Merge** the release PR (it adds the first changeset). The Release workflow then opens "chore: version packages" with everything at 0.1.0. Don't merge that yet.
3. **Publish by hand** from that PR's branch, logged in with `npm login`:
   ```bash
   git fetch && git checkout changeset-release/main
   pnpm install && pnpm build && pnpm test
   pnpm release        # npm asks for your 2FA code for each package
   ```
4. **Trusted publishers:** on npmjs.com, for each of the seven packages: Settings → Trusted Publisher → GitHub Actions, owner `tobibytes`, repository `towhee`, workflow `release.yml`. Then Publishing access → *Require two-factor authentication and disallow tokens*.
5. **Merge** "chore: version packages". The Release workflow finds 0.1.0 already on npm and publishes nothing.
6. **Docker image:** Actions → "Docker image" → Run workflow on `main` with version `0.1.0`. Then on GitHub → Packages → `towhee` → Package settings, set visibility to **Public** (new packages start private) and link it to this repository.
7. **Deploy the site** so the docs match what's published: `pnpm --filter @towhee/site build && cd deploy/cloudflare && pnpm exec wrangler deploy`.
8. **Check:** `npm view @towhee/client version`, `docker pull ghcr.io/tobibytes/towhee:0.1.0`, and the README quick start in an empty folder.

Also once: GitHub → Settings → Actions → General → *Allow GitHub Actions to create and approve pull requests* (if the version PR doesn't appear).
