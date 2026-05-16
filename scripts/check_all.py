import urllib.request, json, sys

def fetch_runs():
    url='https://api.github.com/repos/tsanghung/lotto-predictions/actions/workflows/predict_and_notify.yml/runs?per_page=10'
    req=urllib.request.Request(url, headers={'User-Agent':'check-all-script'})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data=json.load(r)
    except Exception as e:
        print('ERR runs', type(e).__name__, e)
        return
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


def fetch_predictions():
    url='https://raw.githubusercontent.com/tsanghung/lotto-predictions/main/data/predictions.json'
    try:
        s=urllib.request.urlopen(url, timeout=15).read().decode('utf-8')
        data=json.loads(s)
    except Exception as e:
        print('ERR preds', type(e).__name__, e)
        return
    if not data:
        print('No entries')
        return
    print('\nPREDICTIONS: entries:', len(data))
    print('latest timestamp:', data[0].get('timestamp'))
    print('latest game:', data[0].get('game_name'))
    print('is_evaluated:', data[0].get('is_evaluated'))

if __name__=='__main__':
    fetch_runs()
    fetch_predictions()
