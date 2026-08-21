FROM denoland/deno:2.8.3

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
RUN chmod +x /usr/local/bin/swamp

USER swamp
WORKDIR /workspace

STOPSIGNAL SIGTERM

# HEALTHCHECK is intentionally omitted — this image runs arbitrary swamp
# subcommands, not just `swamp serve`. A baked-in healthcheck would fail for
# non-serve usage. Add your own in docker-compose or k8s when running serve.

ENTRYPOINT ["swamp"]
