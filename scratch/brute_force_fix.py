import csv
import json
import os

def load_json(path):
    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return []

def save_json(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def brute_force_import():
    l649_path = r'data\lotto649.json'
    d539_path = r'data\daily539.json'
    l649_data = {item['draw_id']: item for item in load_json(l649_path)}
    d539_data = {item['draw_id']: item for item in load_json(d539_path)}
    
    # Target folders for missing years 2018-2022
    missing_years = ['2018', '2019', '2020', '2021', '2022']
    added_l = 0
    added_d = 0
    
    for year in missing_years:
        search_dir = os.path.join(r'scratch\temp_all', year)
        if not os.path.exists(search_dir): continue
        
        for root, dirs, files in os.walk(search_dir):
            for filename in files:
                if not filename.lower().endswith(".csv"): continue
                csv_path = os.path.join(root, filename)
                
                # Brute force read every CSV
                for enc in ['big5', 'utf-8-sig', 'cp950']:
                    try:
                        with open(csv_path, 'r', encoding=enc, errors='ignore') as f:
                            reader = csv.reader(f)
                            header = next(reader)
                            # Check if this looks like Lotto 649 (13+ columns) or 539 (7+ columns)
                            rows = list(reader)
                            if not rows: continue
                            
                            sample = rows[0]
                            is_l = len(sample) >= 13 and "大樂透" in (header[0] if header else "") or "大樂透" in filename or "nj" in filename.lower()
                            is_d = len(sample) >= 7 and "539" in (header[0] if header else "") or "539" in filename
                            
                            if is_l or is_d:
                                for row in rows:
                                    if len(row) < 7: continue
                                    draw_id = row[1].strip()
                                    if not draw_id or len(draw_id) < 5: continue
                                    date = row[2].strip().replace('/', '-')
                                    
                                    if is_l and len(row) >= 13:
                                        if draw_id not in l649_data:
                                            l649_data[draw_id] = {"draw_id": draw_id, "date": date, "numbers": [int(n) for n in row[6:12]], "special_number": int(row[12])}
                                            added_l += 1
                                    elif is_d:
                                        if draw_id not in d539_data:
                                            d539_data[draw_id] = {"draw_id": draw_id, "date": date, "numbers": [int(n) for n in row[6:11]], "special_number": None}
                                            added_d += 1
                                break # Found correct encoding
                    except: continue

    save_json(l649_path, sorted(l649_data.values(), key=lambda x: x['date']))
    save_json(d539_path, sorted(d539_data.values(), key=lambda x: x['date']))
    print(f"強力修復結果: 大樂透補回 {added_l} 筆, 今彩539補回 {added_d} 筆")

if __name__ == "__main__":
    brute_force_import()
