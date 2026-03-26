FROM denoland/deno:latest
COPY swamp /usr/local/bin/swamp
RUN chmod +x /usr/local/bin/swamp
WORKDIR /workspace
ENTRYPOINT ["swamp"]
