import requests
import json

def test_full_history_index():
    base_url = "https://gaze.nta.gov.tw/ntaOpenApi/restful/D423F"
    
    # 測試幾個關鍵年份：開端(96), 中間(105), 最新(114)
    test_years = ["96", "105", "114", "115"]
    
    results = {}
    
    for year in test_years:
        try:
            resp = requests.get(base_url, params={"syear": year}, verify=False, timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                results[year] = {
                    "status": "Found",
                    "files": [item.get("fName") for item in data],
                    "sample_url": data[0].get("dUrl") if data else None
                }
            else:
                results[year] = {"status": f"Error {resp.status_code}"}
        except Exception as e:
            results[year] = {"status": f"Failed: {str(e)}"}
            
    print(json.dumps(results, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    test_full_history_index()
