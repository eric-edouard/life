# syntax=docker/dockerfile:1
# OpenTunnel's server at a reviewed commit, with the Porkbun DNS hook. Upstream: github.com/anomalyco/opentunnel.
# A new commit is taken only after reading its diff (docs/plans/2026-11-27-private-relay.md).
ARG OPENTUNNEL_COMMIT=8d1ce26b75d7dd5d394490fdb9d881578590af6f

FROM rust:1-bookworm AS server
ARG OPENTUNNEL_COMMIT
WORKDIR /src
RUN git init -q . && git fetch -q --depth 1 https://github.com/anomalyco/opentunnel "$OPENTUNNEL_COMMIT" \
    && git checkout -q FETCH_HEAD
# Our changes to upstream, each one patch: optional-eab (Let's Encrypt needs no ZeroSSL account binding).
COPY *.patch /patches/
RUN git apply /patches/*.patch
RUN cargo build --release --locked -p opentunnel-server \
    && cp target/release/opentunnel-server /usr/local/bin/opentunnel-server

# Debian slim, not distroless: the DNS hook needs a shell, curl and jq.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl jq \
    && rm -rf /var/lib/apt/lists/*
COPY --from=server /usr/local/bin/opentunnel-server /usr/local/bin/opentunnel-server
COPY porkbun-dns-hook.sh /usr/local/bin/porkbun-dns-hook
ENV TLS_LISTEN=[::]:8443 HTTP_LISTEN=[::]:8080 WEBSITE_DIR=/nonexistent
EXPOSE 8443 8080
ENTRYPOINT ["/usr/local/bin/opentunnel-server"]
