import urllib.request, json, sys
url='https://api.github.com/repos/tsanghung/lotto-predictions/actions/workflows/predict_and_notify.yml/runs?per_page=10'
req=urllib.request.Request(url, headers={'User-Agent':'check-runs-script'})
try:
    with urllib.request.urlopen(req, timeout=15) as r:
        data=json.load(r)
except Exception as e:
    print('ERR', type(e).__name__, e)
    sys.exit(1)
runs=data.get('workflow_runs', [])
print('FOUND', len(runs), 'runs')
for r in runs[:10]:
    print('---')
    print('id:', r.get('id'))
    print('event:', r.get('event'))
    print('status:', r.get('status'))
    print('conclusion:', r.get('conclusion'))
    print('created_at:', r.get('created_at'))
    print('updated_at:', r.get('updated_at'))
    print('html_url:', r.get('html_url'))
