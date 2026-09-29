FROM denoland/deno:2.9.7

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
RUN chmod +x /usr/local/bin/swamp && test -x /tini

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
