# Legacy Python Prediction Engine

## Runtime status

The Python prediction stack is legacy-only.

Production does not run:

- `src/main_predict.py`
- `src/analyzer/ai_predictor.py`
- `src/analyzer/stats_engine.py`

Production runtime is owned by Supabase:

- draw update: `supabase/functions/lotto-update`
- prediction and LINE notification: `supabase/functions/lotto-predict-notify`
- scheduling: Supabase Cron
- frontend hosting: Cloudflare Pages

## Why the Python files remain

`stats_engine.py` is still imported by local research and audit tools, such as
backtests, attribution experiments, and rolling calibration scripts. Keep it for
offline analysis unless those tools are migrated to the Edge Function core.

`ai_predictor.py` and `main_predict.py` are historical GitHub Actions-era
prediction pipeline files. Do not wire them back into production jobs.

## Safe usage

Allowed:

- local backtests
- offline statistical experiments
- migration reference while comparing old and new prediction behavior

Not allowed:

- production LINE pushes
- scheduled prediction jobs
- Cloudflare Pages deployment
- Supabase runtime triggers

Any new production prediction behavior must be implemented in
`supabase/functions/lotto-predict-notify`.
