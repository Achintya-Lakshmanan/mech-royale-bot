# Mech Royale bot (steelhead v2). Runs with no network, read-only root (writable /tmp), 1 CPU, 512 MB, map at /arena.
FROM oven/bun:1.4.4-slim
WORKDIR /bot
COPY package.json mechfight.ts map.ts v2.ts ./
ENTRYPOINT ["bun", "/bot/v2.ts"]
