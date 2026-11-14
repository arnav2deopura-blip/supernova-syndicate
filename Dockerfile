FROM python:3.12-slim

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# backend/ includes data/coarse_index.json.gz (the S3 pointing index), so coverage search works without IRSA.
COPY backend/ backend/
ENV SPHEREX_CACHE_DIR=/tmp/spherex-cache \
    PORT=8000
EXPOSE 8000

# One worker: background jobs and their progress live in this process's memory.
# --proxy-headers: the host (Azure/Cloud Run) terminates HTTPS; trust X-Forwarded-Proto so the URLs we
# hand out (blob data, job status) are https://. Otherwise browsers block them as mixed content.
CMD ["sh", "-c", "uvicorn backend.server:app --host 0.0.0.0 --port ${PORT} --workers 1 --proxy-headers --forwarded-allow-ips='*'"]
