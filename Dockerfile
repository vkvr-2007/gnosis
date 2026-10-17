# Gnosis hosted demo: the brain, phone app, reminders and the coding agent. Desktop control and voice
# need the Windows laptop and aren't included. See deploy/README.md.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git gh xz-utils \
 && curl -fsSL https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz \
    | tar -xJ -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE \
 && apt-get purge -y xz-utils && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 gnosis && mkdir /data && chown gnosis /data
WORKDIR /app
COPY pyproject.toml README.md LICENSE ./
COPY gnosis ./gnosis
# Editable, so the code finds config/ and web/ next to it in /app
RUN pip install --no-cache-dir -e ".[phone]"
COPY config ./config
COPY web ./web

USER gnosis
ENV GNOSIS_CONFIG=/app/config/gnosis.cloud.yaml PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/api/health')"
CMD ["gnosis", "serve"]
