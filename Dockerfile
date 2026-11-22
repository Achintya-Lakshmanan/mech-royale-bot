# Mech Royale bot. Runs with no network, read-only root (writable /tmp), 1 CPU, 512 MB, map at /arena.
FROM golang:1.24-bookworm AS build
WORKDIR /src
COPY engine/go.mod ./
COPY engine/mech ./mech
COPY engine/cmd/bot ./cmd/bot
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /mechbot ./cmd/bot

FROM scratch
COPY --from=build /mechbot /mechbot
ENTRYPOINT ["/mechbot"]
