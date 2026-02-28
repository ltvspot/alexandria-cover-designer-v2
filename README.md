# Alexandria Cover Designer v2

AI-powered book cover illustration tool. Generates period-appropriate illustrations for the circular medallion on Alexandria Press covers using OpenRouter image models, then composites them onto source covers.

## Features (Phase 1)

- **Iterate page**: Select a book, choose models and variants, generate with live progress
- **Image generation**: OpenRouter with Gemini 2.5 Flash Image (and others)
- **Compositing**: Feathered circular medallion placement with color-matching
- **Quality scoring**: Multi-factor automated quality assessment
- **Cost tracking**: Per-request ledger with budget monitoring
- **Job system**: Async inline worker with SSE real-time updates
- **Google Drive**: Auto-syncs book catalog from the source folder

## Tech Stack

- Python 3.11, FastAPI, SQLite (via aiosqlite)
- Pillow + OpenCV + NumPy for image processing
- Vanilla HTML/CSS/JS frontend (no build step)
- SSE for real-time job progress
- Single Docker container, deployable to Railway

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Run locally (defaults to port 8080)
uvicorn app.main:app --reload --port 8080
```

Open http://localhost:8080

## Environment Variables

See `.env.example`. All are optional — defaults are hardcoded.

| Variable | Default | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | (hardcoded) | OpenRouter API key |
| `GOOGLE_API_KEY` | (hardcoded) | Google Cloud API key |
| `DRIVE_SOURCE_FOLDER_ID` | (hardcoded) | Source covers folder |
| `DRIVE_OUTPUT_FOLDER_ID` | (hardcoded) | Output destination folder |
| `BUDGET_LIMIT_USD` | `200.0` | Monthly spend limit |
| `PORT` | `8080` | Server port |
| `DEBUG` | `false` | Enable debug logging |

## Deploy to Railway

```bash
railway up
```

The `railway.toml` is pre-configured with health checks and restart policy.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/books` | List all books |
| GET | `/api/books/{id}/cover-preview` | Source cover thumbnail |
| POST | `/api/generate` | Queue generation job |
| GET | `/api/jobs` | List jobs |
| GET | `/api/jobs/{id}` | Job details |
| POST | `/api/jobs/{id}/cancel` | Cancel a queued job |
| GET | `/api/events/job/{id}` | SSE stream for job progress |
| GET | `/api/analytics/costs` | Cost summary |
| GET | `/api/analytics/budget` | Budget status |

## Running Tests

```bash
pytest tests/ -v
```

## Architecture

```
User browser → FastAPI (routes) → Job Queue (SQLite)
                                      ↓
                              Inline Worker (asyncio)
                                      ↓
                    Google Drive ← Cover Download → Pillow/OpenCV
                                      ↓
                              OpenRouter API (generation)
                                      ↓
                              Compositor (medallion placement)
                                      ↓
                              Quality Scorer → SQLite result
                                      ↓
                              SSE → Browser update
```
