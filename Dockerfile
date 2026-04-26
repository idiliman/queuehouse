# Single image: run API or worker (or one-off migrate/bootstrap) via command override.
# See DEPLOY.md for environment variables and operations.
FROM oven/bun:1.2.6

WORKDIR /app

COPY package.json bun.lock turbo.json ./
COPY apps ./apps
COPY packages ./packages
COPY docker/docker-entrypoint.sh /app/docker/docker-entrypoint.sh

RUN bun install --frozen-lockfile \
  && cd packages/db && bunx prisma generate

RUN chmod +x /app/docker/docker-entrypoint.sh

ENV NODE_ENV=production

ENTRYPOINT ["/app/docker/docker-entrypoint.sh"]
CMD ["api"]
