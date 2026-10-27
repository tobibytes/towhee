# The Towhee Node server. Build from the repo root:
#   docker build -t towhee .
#   docker run -p 8080:8080 -e TOWHEE_SECRET=... -v towhee-data:/data towhee
FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@towhee/node..." build
# A standalone folder with only @towhee/node, its built workspace dependencies and production packages.
RUN pnpm --filter @towhee/node deploy --prod /app

FROM node:24-slim
ENV NODE_ENV=production \
    TOWHEE_DATA=/data/towhee.sqlite \
    PORT=8080
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TOWHEE_PORT||process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/bin.js"]
