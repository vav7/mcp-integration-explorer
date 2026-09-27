# MCP Integration Explorer — container image.
# Works on any Docker host (Fly.io, Render, Railway, Cloud Run, a VPS, …).
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8000

WORKDIR /app

# Install deps first for better layer caching
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy the project (data/ ships the last real fetch so it works immediately)
COPY . .

EXPOSE 8000

# On boot the app loads the cached snapshot, then starts a live refresh + the
# background scheduler, so the dashboard is instantly useful and then goes live.
CMD ["sh", "-c", "python -m uvicorn src.app:app --host 0.0.0.0 --port ${PORT}"]
