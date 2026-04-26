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

def utf8_fix_import():
    l649_path = r'data\lotto649.json'
    d539_path = r'data\daily539.json'
    l649_data = {item['draw_id']: item for item in load_json(l649_path)}
    d539_data = {item['draw_id']: item for item in load_json(d539_path)}
    
    added_l = 0
    added_d = 0
    
    # Target folders for 2018-2022
    for year in ['2018', '2019', '2020', '2021', '2022']:
        root_dir = os.path.join(r'scratch\temp_all', year)
        if not os.path.exists(root_dir): continue
        
        for root, dirs, files in os.walk(root_dir):
            for filename in files:
                if not filename.lower().endswith(".csv"): continue
                csv_path = os.path.join(root, filename)
                
                try:
                    # Use utf-8-sig as identified by hex debug
                    with open(csv_path, 'r', encoding='utf-8-sig', errors='ignore') as f:
                        reader = csv.reader(f)
                        header = next(reader, None)
                        if not header: continue
                        
                        first_col = header[0]
                        is_l = "大樂透" in first_col or "遊戲名稱" in first_col and "Lotto649" in filename # Fallback identification
                        is_d = "539" in first_col
                        
                        # Extra check if headers are also mangled but structure is clear
                        rows = list(reader)
                        if not rows: continue
                        
                        # Peek first row to re-verify game type
                        sample = rows[0]
                        game_name = sample[0]
                        
                        is_l649_row = "大樂透" in game_name
                        is_d539_row = "今彩539" in game_name or "539" in game_name
                        
                        for row in [sample] + rows[1:]:
                            if len(row) < 7: continue
                            draw_id = row[1].strip()
                            date = row[2].strip().replace('/', '-')
                            
                            if is_l649_row and len(row) >= 13:
                                if "加開" in row[0]: continue
                                if draw_id not in l649_data:
                                    try:
                                        l649_data[draw_id] = {"draw_id": draw_id, "date": date, "numbers": [int(n) for n in row[6:12]], "special_number": int(row[12])}
                                        added_l += 1
                                    except: pass
                            elif is_d539_row:
                                if draw_id not in d539_data:
                                    try:
                                        d539_data[draw_id] = {"draw_id": draw_id, "date": date, "numbers": [int(n) for n in row[6:11]], "special_number": None}
                                        added_d += 1
                                    except: pass
                except Exception as e:
                    continue

    # Final Sort and Save
    save_json(l649_path, sorted(l649_data.values(), key=lambda x: x['date']))
    save_json(d539_path, sorted(d539_data.values(), key=lambda x: x['date']))
    print(f"UTF-8 修復結果: 大樂透補回 {added_l} 筆, 今彩539補回 {added_d} 筆")

if __name__ == "__main__":
    utf8_fix_import()
