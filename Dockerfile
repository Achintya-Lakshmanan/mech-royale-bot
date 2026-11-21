# Mech Royale bot. Runs with no network, read-only root (writable /tmp), 1 CPU, 512 MB, map at /arena.
# engine2/ is MIT-licensed (see engine2/LICENSE).
FROM oven/bun:1.4.4-slim
WORKDIR /bot
COPY engine2/bot.ts engine2/map.ts engine2/mechfight.ts engine2/LICENSE ./
ENTRYPOINT ["bun", "/bot/bot.ts"]
