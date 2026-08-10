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

## LAI v3 Evidence Agent

LAI v3 是以可重播證據、proper scoring、校正與雙組覆蓋評分為核心的研究 lane。目前只允許 shadow：它不會覆寫正式推薦、不會發送額外 LINE，也不會自動升級為 canary 或 champion。完整的 06:00／10:00 checkpoint、旗標真值表、唯讀 verifier、replay 指令與回復程序請見 [docs/runtime-triggers.md](docs/runtime-triggers.md) 與 [docs/deployment-cloudflare-supabase.md](docs/deployment-cloudflare-supabase.md)。
