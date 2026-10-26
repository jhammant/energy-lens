FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
WORKDIR /app
COPY --chown=node:node build/ ./build/
COPY --chown=node:node LICENSE README.md ./
RUN mkdir /data && chown node:node /data
USER node
ENV ENERGY_LENS_DATA_DIR=/data
VOLUME ["/data"]
ENTRYPOINT ["node", "/app/build/cli.mjs"]
CMD ["status"]
