FROM denoland/deno:2.7.5
COPY swamp /usr/local/bin/swamp
RUN chmod +x /usr/local/bin/swamp
WORKDIR /workspace
ENTRYPOINT ["swamp"]
