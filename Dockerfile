# GenLayer News — single image with both Python (Flask) and Node 20.
# Node is required because app.py spawns scripts/gl_analyse.mjs (genlayer-js)
# as a subprocess to sign and broadcast Bradbury transactions.

FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    NODE_MAJOR=20 \
    PORT=8080

# Install Node 20 from NodeSource alongside Python.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps first (better layer caching).
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Node deps next.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

EXPOSE 8080

# Long timeout: an analyse call holds the request open while the Bradbury
# helper waits up to ~12 min for the tx to reach COMMITTING. We use the
# threaded worker so multiple users can analyse different articles in
# parallel without one stalling the others.
CMD ["gunicorn", \
     "-w", "1", \
     "-k", "gthread", \
     "--threads", "8", \
     "--timeout", "900", \
     "--graceful-timeout", "30", \
     "-b", "0.0.0.0:8080", \
     "app:app"]
