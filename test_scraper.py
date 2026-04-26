import requests

url = "https://api.taiwanlottery.com/TLCAPIWeB/Lottery/Daily539Result"
headers = {
    "User-Agent": "Mozilla/5.0",
}
try:
    requests.packages.urllib3.disable_warnings()
    resp = requests.get(url, headers=headers, params={"period": "", "month": "2024-03"}, timeout=10, verify=False)
    print("Status:", resp.status_code)
    print("Data:", resp.text[:200])
except Exception as e:
    print("Error:", e)
