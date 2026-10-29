# @towhee/core

The [Towhee](https://towhee.madebytobi.com) engine: rooms with Yjs sync and presence, comment threads, version history, per-user inboxes and webhooks, behind a `Connection` and `Storage` interface.

Most people don't use it directly: `@towhee/cloudflare` runs it on Durable Objects and `@towhee/node` runs it as a WebSocket server (also a Docker image). Use it to host Towhee somewhere else, or in tests (`MemoryStorage`, and the shared storage suite in `@towhee/core/testing`).

Docs: [towhee.madebytobi.com/docs](https://towhee.madebytobi.com/docs).
