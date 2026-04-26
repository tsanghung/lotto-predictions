import os
import zipfile
import csv
import json
import shutil
import time

# Paths
ZIP_PATH = r'歷史數據\2026.zip'
TEMP_EXTRACT_DIR = r'scratch\unzip_2026'
DATA_DIR = 'data'
L649_JSON = os.path.join(DATA_DIR, 'lotto649.json')
D539_JSON = os.path.join(DATA_DIR, 'daily539.json')

def load_json(path):
    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return []

def save_json(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def process_sync():
    # 1. Extract ZIP
    if os.path.exists(TEMP_EXTRACT_DIR):
        try:
            shutil.rmtree(TEMP_EXTRACT_DIR)
        except:
            pass
    os.makedirs(TEMP_EXTRACT_DIR, exist_ok=True)
    
    print(f"正在解壓 {ZIP_PATH}...")
    with zipfile.ZipFile(ZIP_PATH, 'r') as zip_ref:
        zip_ref.extractall(TEMP_EXTRACT_DIR)
        
    # 2. Load current databases
    l649_db = {item['draw_id']: item for item in load_json(L649_JSON)}
    d539_db = {item['draw_id']: item for item in load_json(D539_JSON)}
    
    stats = {
        "l649": {"added": 0, "fixed": 0, "unchanged": 0},
        "d539": {"added": 0, "fixed": 0, "unchanged": 0}
    }
    
    # 3. Iterate through extracted CSVs
    for root, dirs, files in os.walk(TEMP_EXTRACT_DIR):
        for filename in files:
            if not filename.lower().endswith(".csv"):
                continue
                
            csv_path = os.path.join(root, filename)
            
            # Read all content into memory
            raw_data = None
            for enc in ['utf-8-sig', 'big5', 'cp950', 'utf-8']:
                try:
                    with open(csv_path, 'r', encoding=enc, errors='ignore') as f:
                        first_line = f.readline()
                        if "遊戲名稱" in first_line or "Game" in first_line or "大樂透" in first_line or "539" in first_line:
                            f.seek(0)
                            raw_data = f.readlines()
                            break
                except: continue
            
            if not raw_data: continue
            
            reader = csv.reader(raw_data)
            header = next(reader, None)
            if not header: continue
            
            # Identify game type
            is_l649 = "大樂透" in header[0] or "Lotto649" in filename or "大樂透" in raw_data[1]
            is_d539 = "539" in header[0] or "Daily539" in filename or "539" in raw_data[1]
            
            for row in reader:
                if len(row) < 7: continue
                draw_id = row[1].strip()
                if not draw_id: continue
                date = row[2].strip().replace('/', '-')
                
                if is_l649 and len(row) >= 13:
                    if "加開" in row[0]: continue
                    try:
                        nums = [int(n) for n in row[6:12]]
                        special = int(row[12])
                        new_item = {"draw_id": draw_id, "date": date, "numbers": nums, "special_number": special}
                        
                        if draw_id not in l649_db:
                            l649_db[draw_id] = new_item
                            stats["l649"]["added"] += 1
                        elif l649_db[draw_id] != new_item:
                            l649_db[draw_id] = new_item
                            stats["l649"]["fixed"] += 1
                        else:
                            stats["l649"]["unchanged"] += 1
                    except: continue
                        
                elif is_d539 and len(row) >= 11:
                    try:
                        nums = [int(n) for n in row[6:11]]
                        new_item = {"draw_id": draw_id, "date": date, "numbers": nums, "special_number": None}
                        
                        if draw_id not in d539_db:
                            d539_db[draw_id] = new_item
                            stats["d539"]["added"] += 1
                        elif d539_db[draw_id] != new_item:
                            d539_db[draw_id] = new_item
                            stats["d539"]["fixed"] += 1
                        else:
                            stats["d539"]["unchanged"] += 1
                    except: continue

    # 4. Save results
    if stats["l649"]["added"] > 0 or stats["l649"]["fixed"] > 0:
        save_json(L649_JSON, sorted(l649_db.values(), key=lambda x: x['date']))
    if stats["d539"]["added"] > 0 or stats["d539"]["fixed"] > 0:
        save_json(D539_JSON, sorted(d539_db.values(), key=lambda x: x['date']))
        
    print("\n--- 2026 對帳結果報告 ---")
    print(f"大樂透 (Lotto 649):")
    print(f"  - 新增: {stats['l649']['added']} 筆")
    print(f"  - 修正: {stats['l649']['fixed']} 筆")
    print(f"  - 無變動: {stats['l649']['unchanged']} 筆")
    print(f"今彩 539 (Daily 539):")
    print(f"  - 新增: {stats['d539']['added']} 筆")
    print(f"  - 修正: {stats['d539']['fixed']} 筆")
    print(f"  - 無變動: {stats['d539']['unchanged']} 筆")

    # Clean up
    time.sleep(1)
    for _ in range(3):
        try:
            shutil.rmtree(TEMP_EXTRACT_DIR)
            break
        except:
            time.sleep(1)

if __name__ == "__main__":
    process_sync()
