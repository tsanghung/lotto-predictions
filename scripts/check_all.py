import urllib.request, json
from datetime import datetime, timezone, timedelta

TAIPEI = timezone(timedelta(hours=8))


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'check-all-script'})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def fetch_workflows():
    # predict_and_notify.yml was intentionally removed; predictions now run on Supabase
    # Cron (docs/runtime-triggers.md). List the real workflows instead of probing a
    # deleted one (which always 404/403s).
    api = 'https://api.github.com/repos/tsanghung/lotto-predictions/actions/workflows'
    try:
        workflows = get(api).get('workflows', [])
    except Exception as e:
        print('ERR workflows', type(e).__name__, e)
        return
    print('FOUND', len(workflows), 'workflow(s) (predictions run on Supabase Cron, not GitHub Actions)')
    for w in workflows:
        print('---')
        print('name:', w.get('name'), '| path:', w.get('path'), '| state:', w.get('state'))
        try:
            runs = get(w.get('url', '') + '/runs?per_page=1').get('workflow_runs', [])
            if runs:
                r = runs[0]
                print('latest run:', r.get('status'), r.get('conclusion'), r.get('created_at'))
            else:
                print('latest run: none')
        except Exception as e:
            print('latest run: ERR', type(e).__name__, e)


def fetch_predictions():
    url = 'https://raw.githubusercontent.com/tsanghung/lotto-predictions/main/data/predictions.json'
    try:
        s = urllib.request.urlopen(url, timeout=15).read().decode('utf-8')
        data = json.loads(s)
    except Exception as e:
        print('ERR preds', type(e).__name__, e)
        return
    if not data:
        print('No entries')
        return
    # predictions.json is stored OLDEST-first; resolve latest/oldest by timestamp, not position.
    latest = max(data, key=lambda x: x.get('timestamp', ''))
    oldest = min(data, key=lambda x: x.get('timestamp', ''))
    print('\nPREDICTIONS: entries:', len(data))
    print('oldest timestamp:', oldest.get('timestamp'))
    print('latest timestamp:', latest.get('timestamp'))
    print('latest game:', latest.get('game_name'))
    print('latest is_evaluated:', latest.get('is_evaluated'))
    try:
        ts = datetime.fromisoformat(latest['timestamp'])
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=TAIPEI)
        age_days = (datetime.now(TAIPEI) - ts).days
        print('latest age (days):', age_days)
        if age_days > 3:
            print('WARN snapshot looks stale (>3 days); live data is in Supabase prediction_records.')
    except Exception as e:
        print('age check skipped:', type(e).__name__, e)


if __name__ == '__main__':
    fetch_workflows()
    fetch_predictions()
