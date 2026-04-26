import os
import zipfile
import csv
import json
import shutil

# Configurations
HISTORY_DIR = '歷史數據'
DATA_DIR = 'data'
L649_JSON = os.path.join(DATA_DIR, 'lotto649.json')
D539_JSON = os.path.join(DATA_DIR, 'daily539.json')
TEMP_DIR = r'scratch\full_reconcile'

def load_json(path):
    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return []

def full_reconciliation():
    # 1. Load current DB
    l649_db = {item['draw_id']: item for item in load_json(L649_JSON)}
    d539_db = {item['draw_id']: item for item in load_json(D539_JSON)}
    
    report = {
        "L649": {"match": 0, "mismatch": [], "missing_in_db": [], "db_total": len(l649_db)},
        "D539": {"match": 0, "mismatch": [], "missing_in_db": [], "db_total": len(d539_db)}
    }
    
    if os.path.exists(TEMP_DIR): shutil.rmtree(TEMP_DIR)
    os.makedirs(TEMP_DIR)
    
    # 2. Iterate through all Zips
    zips = sorted([f for f in os.listdir(HISTORY_DIR) if f.endswith('.zip')])
    
    for zip_name in zips:
        zip_path = os.path.join(HISTORY_DIR, zip_name)
        extract_path = os.path.join(TEMP_DIR, zip_name[:-4])
        os.makedirs(extract_path, exist_ok=True)
        
        try:
            with zipfile.ZipFile(zip_path, 'r') as z:
                z.extractall(extract_path)
            
            # 3. Parse all CSVs in this zip
            for root, dirs, files in os.walk(extract_path):
                for filename in files:
                    if not filename.lower().endswith(".csv"): continue
                    csv_p = os.path.join(root, filename)
                    
                    # Detect encoding
                    data_rows = []
                    for enc in ['utf-8-sig', 'big5', 'cp950', 'utf-8']:
                        try:
                            with open(csv_p, 'r', encoding=enc, errors='ignore') as f:
                                content = f.readlines()
                                if any("遊戲名稱" in l or "大樂透" in l or "539" in l for l in content[:3]):
                                    reader = csv.reader(content)
                                    next(reader, None)
                                    data_rows = list(reader)
                                    break
                        except: continue
                    
                    if not data_rows: continue
                    
                    for row in data_rows:
                        if len(row) < 7: continue
                        draw_id = row[1].strip()
                        if not draw_id or len(draw_id) < 5: continue
                        
                        # Identify Game
                        is_l = "大樂透" in row[0] and len(row) >= 13
                        is_d = "539" in row[0] and len(row) >= 11
                        
                        if is_l:
                            nums = [int(n) for n in row[6:12]]
                            spec = int(row[12])
                            if draw_id not in l649_db:
                                report["L649"]["missing_in_db"].append(draw_id)
                            else:
                                db_item = l649_db[draw_id]
                                if db_item['numbers'] == nums and db_item['special_number'] == spec:
                                    report["L649"]["match"] += 1
                                else:
                                    report["L649"]["mismatch"].append(draw_id)
                        elif is_d:
                            nums = [int(n) for n in row[6:11]]
                            if draw_id not in d539_db:
                                report["D539"]["missing_in_db"].append(draw_id)
                            else:
                                db_item = d539_db[draw_id]
                                if db_item['numbers'] == nums:
                                    report["D539"]["match"] += 1
                                else:
                                    report["D539"]["mismatch"].append(draw_id)
        except: pass
        
    shutil.rmtree(TEMP_DIR)
    
    # 4. Final Report
    print("\n" + "="*40)
    print("      全量數據官方對帳報告")
    print("="*40)
    for game in ["L649", "D539"]:
        res = report[game]
        print(f"[{game} - {'大樂透' if game=='L649' else '今彩539'}]")
        print(f"  - 資料庫總數: {res['db_total']} 筆")
        print(f"  - 官方比對一致: {res['match']} 筆")
        
        if res['mismatch']:
            print(f"  - MISMATCH (Data incorrect): {len(res['mismatch'])} items -> {res['mismatch'][:10]}")
        else:
            print(f"  - Accuracy: 100% MATCHED")
            
        if res['missing_in_db']:
            print(f"  - MISSING IN DB: {len(res['missing_in_db'])} items -> {res['missing_in_db'][:10]}")
        else:
            print(f"  - Completeness: 100% COMPLETE (Based on Official Files)")
        
        # Check if DB has extras
        if res['db_total'] > res['match'] + len(res['mismatch']):
            print(f"  - EXTRA IN DB (Not in Official ZIPs): {res['db_total'] - res['match'] - len(res['mismatch'])} items")

if __name__ == "__main__":
    full_reconciliation()
