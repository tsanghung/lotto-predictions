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

def final_repair():
    l649_path = r'data\lotto649.json'
    d539_path = r'data\daily539.json'
    l649_data = {item['draw_id']: item for item in load_json(l649_path)}
    d539_data = {item['draw_id']: item for item in load_json(d539_path)}
    
    # Pre-encode keywords for Big5 matching
    kw_l649 = "大樂透".encode('big5')
    kw_d539 = "今彩539".encode('big5')
    
    added_l = 0
    added_d = 0
    
    # Scan all years
    for root, dirs, files in os.walk(r'scratch\temp_all'):
        for filename in files:
            if not filename.lower().endswith(".csv"): continue
            csv_path = os.path.join(root, filename)
            
            # Read as raw bytes to identify type
            try:
                with open(csv_path, 'rb') as f:
                    first_line = f.readline()
                    # Check next line for data
                    second_line = f.readline()
                    
                    is_l = kw_l649 in first_line or kw_l649 in second_line
                    is_d = kw_d539 in first_line or kw_d539 in second_line
                    
                    if not (is_l or is_d): continue
                    
                    # If identified, read with big5
                    f.seek(0)
                    content = f.read().decode('big5', errors='ignore')
                    lines = content.splitlines()
                    reader = csv.reader(lines)
                    next(reader, None) # Skip header
                    
                    for row in reader:
                        if len(row) < 7: continue
                        draw_id = row[1].strip()
                        if not draw_id or len(draw_id) < 5: continue
                        
                        date_raw = row[2].strip().replace('/', '-')
                        parts = date_raw.split('-')
                        if len(parts) == 3:
                            date = f"{parts[0]}-{parts[1].zfill(2)}-{parts[2].zfill(2)}"
                        else: continue
                        
                        if is_l and len(row) >= 13:
                            if "加開" in row[0]: continue
                            if draw_id not in l649_data:
                                try:
                                    l649_data[draw_id] = {"draw_id": draw_id, "date": date, "numbers": [int(n) for n in row[6:12]], "special_number": int(row[12])}
                                    added_l += 1
                                except: pass
                        elif is_d:
                            if draw_id not in d539_data:
                                try:
                                    d539_data[draw_id] = {"draw_id": draw_id, "date": date, "numbers": [int(n) for n in row[6:11]], "special_number": None}
                                    added_d += 1
                                except: pass
            except Exception as e:
                continue

    save_json(l649_path, sorted(l649_data.values(), key=lambda x: x['date']))
    save_json(d539_path, sorted(d539_data.values(), key=lambda x: x['date']))
    print(f"最終修復結果: 大樂透補回 {added_l} 筆, 今彩539補回 {added_d} 筆")

if __name__ == "__main__":
    final_repair()
