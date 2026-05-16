import urllib.request, json, sys
url='https://raw.githubusercontent.com/tsanghung/lotto-predictions/main/data/predictions.json'
try:
    s=urllib.request.urlopen(url, timeout=15).read().decode('utf-8')
    data=json.loads(s)
except Exception as e:
    print('ERR', type(e).__name__, e)
    sys.exit(1)
if not data:
    print('No entries')
    sys.exit(0)
print('entries:', len(data))
print('latest timestamp:', data[0].get('timestamp'))
print('latest game:', data[0].get('game_name'))
print('is_evaluated:', data[0].get('is_evaluated'))
