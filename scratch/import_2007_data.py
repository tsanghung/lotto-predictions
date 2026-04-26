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

def import_lotto649():
    csv_path = r'scratch\temp_2007\96\大樂透_2007.csv'
    json_path = r'data\lotto649.json'
    
    current_data = {item['draw_id']: item for item in load_json(json_path)}
    new_count = 0
    
    try:
        with open(csv_path, mode='r', encoding='utf-8-sig') as f:
            reader = csv.reader(f)
            header = next(reader)
            for row in reader:
                if not row or len(row) < 13: continue
                
                draw_id = row[1].strip()
                date_raw = row[2].strip() # 2007/01/02
                date = date_raw.replace('/', '-')
                
                numbers = [int(n) for n in row[6:12]]
                special = int(row[12])
                
                if draw_id not in current_data:
                    current_data[draw_id] = {
                        "draw_id": draw_id,
                        "date": date,
                        "numbers": numbers,
                        "special_number": special
                    }
                    new_count += 1
    except Exception as e:
        print(f"Lotto649 Import Error: {e}")
        return

    # Sort by date
    sorted_data = sorted(current_data.values(), key=lambda x: x['date'])
    save_json(json_path, sorted_data)
    print(f"大樂透導入成功: 新增 {new_count} 筆，總計 {len(sorted_data)} 筆")

def import_daily539():
    csv_path = r'scratch\temp_2007\96\今彩539_2007.csv'
    json_path = r'data\daily539.json'
    
    current_data = {item['draw_id']: item for item in load_json(json_path)}
    new_count = 0
    
    try:
        with open(csv_path, mode='r', encoding='utf-8-sig') as f:
            reader = csv.reader(f)
            header = next(reader)
            for row in reader:
                if not row or len(row) < 7: continue
                
                draw_id = row[1].strip()
                date_raw = row[2].strip()
                date = date_raw.replace('/', '-')
                
                numbers = [int(n) for n in row[6:11]]
                
                if draw_id not in current_data:
                    current_data[draw_id] = {
                        "draw_id": draw_id,
                        "date": date,
                        "numbers": numbers,
                        "special_number": None
                    }
                    new_count += 1
    except Exception as e:
        print(f"Daily539 Import Error: {e}")
        return

    # Sort by date
    sorted_data = sorted(current_data.values(), key=lambda x: x['date'])
    save_json(json_path, sorted_data)
    print(f"今彩539導入成功: 新增 {new_count} 筆，總計 {len(sorted_data)} 筆")

if __name__ == "__main__":
    import_lotto649()
    import_daily539()
    
    # Update meta.json
    l649 = load_json(r'data\lotto649.json')
    d539 = load_json(r'data\daily539.json')
    meta = load_json(r'data\meta.json')
    if isinstance(meta, dict):
        meta['lotto649_total'] = len(l649)
        meta['daily539_total'] = len(d539)
        save_json(r'data\meta.json', meta)
