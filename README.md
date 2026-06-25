# Lotto predictions

A fully automated, AI-driven lottery prediction system with statistical analysis, web sentiment tracking, and scientific attribution.

## Core Features
- **Supabase Runtime**: Production draw updates, AI predictions, and LINE pushes run through Supabase Edge Functions and Supabase Cron.
- **AI Prediction Engine**: Gemini-assisted quantitative prediction runs in `supabase/functions/lotto-predict-notify`.
- **Premium Dashboard**: Vue 3 dashboard deployed by Cloudflare Pages.
- **Legacy Python Research Tools**: The old Python prediction stack is kept only for offline analysis and backtesting.

## Tech Stack
- **Production Backend**: Supabase Edge Functions, Deno runtime, Supabase Postgres.
- **Frontend**: Vue 3, Vite, Tailwind CSS, Chart.js.
- **Data**: Supabase Postgres with static JSON fallback files.
- **Automation**: Supabase Cron for runtime jobs; GitHub Actions only performs syntax checks.
- **Deployment**: Cloudflare Pages.

## Legacy Python Engine

`src/analyzer/stats_engine.py`, `src/analyzer/ai_predictor.py`, and `src/main_predict.py`
are not production runtime code. They are retained as legacy/offline research
helpers only. See [docs/legacy-python-engine.md](docs/legacy-python-engine.md).

## Cloudflare Pages + Supabase

See [docs/deployment-cloudflare-supabase.md](docs/deployment-cloudflare-supabase.md).
