# Mech Royale bot. Runs with no network, read-only root (writable /tmp), 1 CPU, 512 MB, map at /arena.
# engine/ is MIT-licensed (see engine/LICENSE).
FROM python:3.13.9-slim
WORKDIR /bot
COPY engine/mechfight.py engine/bot.py engine/LICENSE ./
ENTRYPOINT ["python3", "-u", "/bot/bot.py"]
