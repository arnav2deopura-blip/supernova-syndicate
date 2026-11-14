# Run and deploy

## Local

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
cp .env.example .env
uvicorn backend.server:app --reload --port 8000
python -m http.server 5500 --directory frontend
```

Open http://localhost:5500. Add `?mock=1` to use `frontend/mock/` without a backend.

Run the tests:

```bash
pytest
```

## Frontend (GitHub Pages)

`.github/workflows/deploy-frontend.yml` publishes `frontend/` on every push to `main`.

One-time setup: GitHub → Settings → Pages → Source: **GitHub Actions**.

## Backend (container)

```bash
docker build -t spherex-api .
docker run -p 8000:8000 -e ALLOWED_ORIGINS=https://<user>.github.io spherex-api
```

Deploy the same image to the host the team picks (Google Cloud Run, Azure Container Apps, etc.). **[TODO: record the chosen host and the live URL here.]**

After deploying, set `API_BASE` in `frontend/js/api.js` to the backend URL.

## Before judging

- Hit the backend once to wake it up (free hosts sleep).
- Confirm the five presets load from `frontend/precomputed/` with the backend off.
- Open every link in a private window.
