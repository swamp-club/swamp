# syntax=docker/dockerfile:1.7

# The swamp-club golden base image: Ubuntu 24.04 + Deno + tini, the lowest
# layer every swamp-club image is built FROM (platform-swamp images/golden,
# swamp-club lab #4476). It is public, pinned here by digest, and replaces
# denoland/deno with the same layout: deno at /usr/bin/deno, tini at /tini,
# DENO_DIR=/deno-dir, uid 1000 free. GOLDEN_DENO must match .tool-versions
# (integration/toolchain_pins_rules_test.ts), and the build fails if the base's
# deno is any other version.
ARG GOLDEN_DENO=2.9.8

# Litestream for v3 datastore replication (swamp-club#3358), pinned to
# LITESTREAM_PIN in src/infrastructure/datastore_v3/litestream/litestream_pin.ts.
# `deno run litestream-pin --version <version>` rewrites the two ADD lines, and
# integration/toolchain_pins_rules_test.ts fails if they drift from the pin.
# ADD --checksum needs BuildKit (docker buildx, or Docker 23+); the classic
# builder is not supported. TARGETARCH picks the stage for the platform built.
FROM scratch AS litestream-amd64
ADD --checksum=sha256:cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d https://github.com/benbjohnson/litestream/releases/download/v0.5.17/litestream-0.5.17-linux-x86_64.tar.gz /litestream.tar.gz

FROM scratch AS litestream-arm64
ADD --checksum=sha256:f8ca4a050095c1efbda2c4365172e61bf9d955ea0d9ac42f448b52e51819baa5 https://github.com/benbjohnson/litestream/releases/download/v0.5.17/litestream-0.5.17-linux-arm64.tar.gz /litestream.tar.gz

FROM litestream-${TARGETARCH} AS litestream

FROM us-west1-docker.pkg.dev/swamp-club-archive/golden/base@sha256:477d1f4adb81ba3d8b2cb8cdd3b398d20e542ec6196624e6c7583c46336cb8c5
ARG GOLDEN_DENO

ARG SWAMP_VERSION="dev"
ARG VCS_REF=""
ARG BUILD_DATE=""

LABEL org.opencontainers.image.title="swamp" \
      org.opencontainers.image.description="AI Native Automation CLI" \
      org.opencontainers.image.vendor="swamp-club" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/swamp-club/swamp" \
      org.opencontainers.image.version="${SWAMP_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}"

RUN groupadd --gid 1000 swamp \
    && useradd --uid 1000 --gid swamp --create-home swamp \
    && mkdir -p /workspace \
    && chown swamp:swamp /workspace

COPY swamp /usr/local/bin/swamp
RUN chmod +x /usr/local/bin/swamp && test -x /tini \
    && deno --version | grep -q "^deno ${GOLDEN_DENO} "

# The image redistributes Litestream, so its Apache-2.0 licence travels with it.
# swamp hashes the binary against the pin before every start, and the override
# path means serve never downloads it at runtime.
COPY --from=litestream /litestream.tar.gz /tmp/litestream.tar.gz
RUN tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream \
    && mkdir -p /usr/share/doc/litestream \
    && tar -xzf /tmp/litestream.tar.gz -C /usr/share/doc/litestream LICENSE \
    && rm /tmp/litestream.tar.gz \
    && chmod 0755 /usr/local/bin/litestream
ENV SWAMP_LITESTREAM_PATH=/usr/local/bin/litestream

USER swamp
WORKDIR /workspace

STOPSIGNAL SIGTERM

# HEALTHCHECK is intentionally omitted — this image runs arbitrary swamp
# subcommands, not just `swamp serve`. A baked-in healthcheck would fail for
# non-serve usage. Add your own in docker-compose or k8s when running serve.

# swamp must not run as PID 1: Linux re-parents orphaned processes to PID 1,
# and swamp only waits on the children it spawned itself, so every process a
# step leaves behind would stay a zombie until the container exits. The base
# image's tini reaps them and forwards signals to swamp. `-s` registers tini as
# a child subreaper, so it still reaps (and stays quiet) when it is not PID 1,
# e.g. under `docker run --init`.
ENTRYPOINT ["/tini", "-s", "--", "swamp"]
