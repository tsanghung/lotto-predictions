import urllib.request, json, sys
from datetime import datetime, timezone, timedelta

URL = 'https://raw.githubusercontent.com/tsanghung/lotto-predictions/main/data/predictions.json'
TAIPEI = timezone(timedelta(hours=8))

try:
    s = urllib.request.urlopen(URL, timeout=15).read().decode('utf-8')
    data = json.loads(s)
except Exception as e:
    print('ERR', type(e).__name__, e)
    sys.exit(1)

if not data:
    print('No entries')
    sys.exit(0)

# data/predictions.json is stored OLDEST-first, so data[0] is the earliest entry,
# not the latest. Always resolve newest/oldest by timestamp, never by position.
latest = max(data, key=lambda x: x.get('timestamp', ''))
oldest = min(data, key=lambda x: x.get('timestamp', ''))

print('entries:', len(data))
print('oldest timestamp:', oldest.get('timestamp'))
print('latest timestamp:', latest.get('timestamp'))
print('latest game:', latest.get('game_name'))
print('latest is_evaluated:', latest.get('is_evaluated'))

# Freshness: predictions are produced by Supabase Cron (Taiwan 10:00) on draw days and
# this file is only a committed snapshot; the live source of truth is Supabase
# prediction_records. Flag a stale snapshot so it is not mistaken for current output.
try:
    ts = datetime.fromisoformat(latest['timestamp'])
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=TAIPEI)
    age_days = (datetime.now(TAIPEI) - ts).days
    print('latest age (days):', age_days)
    if age_days > 3:
        print('WARN snapshot looks stale (>3 days). data/predictions.json is a committed '
              'snapshot; live predictions live in Supabase prediction_records.')
except Exception as e:
    print('age check skipped:', type(e).__name__, e)
