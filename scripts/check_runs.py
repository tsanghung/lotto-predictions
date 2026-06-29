import urllib.request, json, sys

# NOTE: predictions are NO LONGER produced by GitHub Actions. The prediction + LINE
# pipeline was intentionally moved to Supabase Cron + Edge Function (see
# docs/runtime-triggers.md: "不要重新加入 GitHub Actions schedule 或正式 runtime workflow").
# The old predict_and_notify.yml workflow was deleted, so probing it always 404/403s.
# This script now lists the repo's actual workflows and their latest run, which is
# truthful; for prediction freshness use check_predictions.py instead.
API = 'https://api.github.com/repos/tsanghung/lotto-predictions/actions/workflows'


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'check-runs-script'})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


try:
    workflows = get(API).get('workflows', [])
except Exception as e:
    print('ERR', type(e).__name__, e)
    sys.exit(1)

print('FOUND', len(workflows), 'workflow(s)')
print('(prediction pipeline runs on Supabase Cron, not GitHub Actions)')
for w in workflows:
    print('---')
    print('name:', w.get('name'))
    print('path:', w.get('path'))
    print('state:', w.get('state'))
    try:
        runs = get(w.get('url', '') + '/runs?per_page=1').get('workflow_runs', [])
    except Exception as e:
        print('latest run: ERR', type(e).__name__, e)
        continue
    if not runs:
        print('latest run: none')
        continue
    r = runs[0]
    print('latest run:', r.get('status'), r.get('conclusion'), r.get('created_at'))
    print('html_url:', r.get('html_url'))
