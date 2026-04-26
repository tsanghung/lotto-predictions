import requests
import json

def test_nta_api():
    # Base URL from the swagger doc
    base_url = "https://gaze.nta.gov.tw/ntaOpenApi/restful/D423F"
    
    # Test for Minguo 114 (2025)
    params = {
        "syear": "114",
        "limit": 100
    }
    
    print(f"正在請求官方 API: {base_url} (年度: 114)")
    
    try:
        response = requests.get(base_url, params=params, verify=False)
        if response.status_code == 200:
            data = response.json()
            print("--- API 請求成功 ---")
            print(json.dumps(data, indent=2, ensure_ascii=False))
        else:
            print(f"API 請求失敗，狀態碼: {response.status_code}")
            print(response.text)
    except Exception as e:
        print(f"發生錯誤: {e}")

if __name__ == "__main__":
    test_nta_api()
