import requests
import json
import os
import zipfile
import csv
import glob
import shutil
from datetime import datetime

# Base configurations — 使用 __file__ 計算絕對路徑，避免 CWD 依賴問題
# src/scraper/official_sync.py -> 往上兩層到專案根目錄
_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

NTA_API_URL = "https://gaze.nta.gov.tw/ntaOpenApi/restful/D423F"
HISTORY_DIR = os.path.join(_BASE_DIR, "歷史數據")
DATA_DIR = os.path.join(_BASE_DIR, "data")
TEMP_DIR = os.path.join(_BASE_DIR, "scratch", "sync_temp")  # 使用 os.path.join，相容 Linux CI

def load_json(path):
    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return []

def save_json(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def import_csv_to_json(csv_file, l649_data, d539_data):
    """Parses a single CSV and adds to the provided dictionaries."""
    is_l649 = False
    is_d539 = False
    
    # Identify content
    for enc in ['utf-8-sig', 'big5', 'cp950']:
        try:
            with open(csv_file, mode='r', encoding=enc, errors='ignore') as f:
                line = f.readline()
                if "大樂透" in line: is_l649 = True; break
                if "539" in line: is_d539 = True; break
        except: continue
    
    if not (is_l649 or is_d539): return 0, 0

    added_l649 = 0
    added_d539 = 0
    
    try:
        with open(csv_file, mode='r', encoding=enc, errors='ignore') as f:
            reader = csv.reader(f)
            next(reader, None) # Skip header
            for row in reader:
                if not row or len(row) < 7: continue
                draw_id = row[1].strip()
                if not draw_id: continue
                
                date_raw = row[2].strip().replace('/', '-')
                parts = date_raw.split('-')
                if len(parts) == 3:
                    date = f"{parts[0]}-{parts[1].zfill(2)}-{parts[2].zfill(2)}"
                else: continue
                
                if is_l649 and len(row) >= 13:
                    if "加開" in row[0]: continue
                    if draw_id not in l649_data:
                        l649_data[draw_id] = {"draw_id": draw_id, "date": date, "numbers": [int(n) for n in row[6:12]], "special_number": int(row[12])}
                        added_l649 += 1
                elif is_d539:
                    if draw_id not in d539_data:
                        d539_data[draw_id] = {"draw_id": draw_id, "date": date, "numbers": [int(n) for n in row[6:11]], "special_number": None}
                        added_d539 += 1
    except Exception as e:
        print(f"解析 {os.path.basename(csv_file)} 錯誤: {e}")
        
    return added_l649, added_d539

def sync_with_official_api():
    print(f"--- 官方 API 自動對帳啟動 ({datetime.now().strftime('%Y-%m-%d %H:%M:%S')}) ---")

    # 確保必要目錄存在（首次執行時自動建立）
    os.makedirs(HISTORY_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)

    # Current Minguo year
    current_year_minguo = datetime.now().year - 1911
    years_to_check = [str(current_year_minguo), str(current_year_minguo - 1)]
    
    # Load existing database
    l649_path = os.path.join(DATA_DIR, "lotto649.json")
    d539_path = os.path.join(DATA_DIR, "daily539.json")
    l649_data = {item['draw_id']: item for item in load_json(l649_path)}
    d539_data = {item['draw_id']: item for item in load_json(d539_path)}
    
    total_added_l649 = 0
    total_added_d539 = 0
    
    for syear in years_to_check:
        print(f"正在檢查民國 {syear} 年官方資料...")
        try:
            resp = requests.get(NTA_API_URL, params={"syear": syear, "limit": 10}, verify=False)
            if resp.status_code != 200: continue
            
            records = resp.json()
            for rec in records:
                download_url = rec.get("dUrl")
                if not download_url: continue
                
                filename = download_url.split("/")[-1]
                local_zip = os.path.join(HISTORY_DIR, filename)
                
                # If file doesn't exist locally, download it
                if not os.path.exists(local_zip):
                    print(f"發現新官方資料: {filename}，正在下載...")
                    try:
                        r = requests.get(download_url, verify=False, timeout=30)
                        if r.status_code == 200:
                            with open(local_zip, 'wb') as f:
                                f.write(r.content)
                        else:
                            print(f"下載失敗 (HTTP {r.status_code}): {download_url}")
                            continue
                    except Exception as e:
                        print(f"下載出錯: {e}")
                        continue
                
                # Extract and import
                if os.path.exists(local_zip):
                    print(f"正在從 {filename} 導入數據...")
                    if os.path.exists(TEMP_DIR): shutil.rmtree(TEMP_DIR)
                    os.makedirs(TEMP_DIR)
                    
                    try:
                        with zipfile.ZipFile(local_zip, 'r') as zip_ref:
                            zip_ref.extractall(TEMP_DIR)
                        
                        # Find all CSVs recursively
                        for root, dirs, files in os.walk(TEMP_DIR):
                            for csv_f in files:
                                if csv_f.lower().endswith(".csv"):
                                    a1, a2 = import_csv_to_json(os.path.join(root, csv_f), l649_data, d539_data)
                                    total_added_l649 += a1
                                    total_added_d539 += a2
                    except Exception as e:
                        print(f"解壓/導入 {filename} 失敗: {e}")
                    finally:
                        if os.path.exists(TEMP_DIR): shutil.rmtree(TEMP_DIR)
                        
        except Exception as e:
            print(f"查詢 API (年度 {syear}) 出錯: {e}")

    if total_added_l649 > 0 or total_added_d539 > 0:
        # Sort and save
        save_json(l649_path, sorted(l649_data.values(), key=lambda x: x['date']))
        save_json(d539_path, sorted(d539_data.values(), key=lambda x: x['date']))
        
        # Update meta
        meta_path = os.path.join(DATA_DIR, "meta.json")
        meta = load_json(meta_path)
        if isinstance(meta, dict):
            meta['lotto649_total'] = len(l649_data)
            meta['daily539_total'] = len(d539_data)
            meta['last_sync'] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            save_json(meta_path, meta)
            
        print(f"同步完成！大樂透新增 {total_added_l649} 筆，今彩539新增 {total_added_d539} 筆。")
    else:
        print("官方資料無新變動。")

if __name__ == "__main__":
    sync_with_official_api()
