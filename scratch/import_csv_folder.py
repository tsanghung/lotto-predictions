import csv
import json
import os
import glob

def load_json(path):
    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return []

def save_json(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def import_from_folder(folder_path):
    l649_path = r'data\lotto649.json'
    d539_path = r'data\daily539.json'
    
    l649_data = {item['draw_id']: item for item in load_json(l649_path)}
    d539_data = {item['draw_id']: item for item in load_json(d539_path)}
    
    l649_count = 0
    d539_count = 0
    
    # Search for files
    files = glob.glob(os.path.join(folder_path, "*.csv"))
    
    for csv_file in files:
        filename = os.path.basename(csv_file)
        
        # Determine lotto type
        is_l649 = "大樂透" in filename
        is_d539 = "今彩539" in filename
        
        if not (is_l649 or is_d539):
            continue
            
        print(f"處理檔案: {filename}")
        
        try:
            with open(csv_file, mode='r', encoding='utf-8-sig') as f:
                reader = csv.reader(f)
                header = next(reader)
                for row in reader:
                    if not row or len(row) < 7: continue
                    
                    draw_id = row[1].strip()
                    date = row[2].strip().replace('/', '-')
                    
                    if is_l649:
                        if len(row) < 13: continue
                        numbers = [int(n) for n in row[6:12]]
                        special = int(row[12])
                        if draw_id not in l649_data:
                            l649_data[draw_id] = {"draw_id": draw_id, "date": date, "numbers": numbers, "special_number": special}
                            l649_count += 1
                    elif is_d539:
                        numbers = [int(n) for n in row[6:11]]
                        if draw_id not in d539_data:
                            d539_data[draw_id] = {"draw_id": draw_id, "date": date, "numbers": numbers, "special_number": None}
                            d539_count += 1
                            
        except Exception as e:
            print(f"Error processing {filename}: {e}")

    # Sort by date and save
    sorted_l649 = sorted(l649_data.values(), key=lambda x: x['date'])
    sorted_d539 = sorted(d539_data.values(), key=lambda x: x['date'])
    
    save_json(l649_path, sorted_l649)
    save_json(d539_path, sorted_d539)
    
    # Update meta
    meta = load_json(r'data\meta.json')
    if isinstance(meta, dict):
        meta['lotto649_total'] = len(sorted_l649)
        meta['daily539_total'] = len(sorted_d539)
        save_json(r'data\meta.json', meta)
        
    print(f"導入完成！")
    print(f"大樂透: 新增 {l649_count} 筆，總計 {len(sorted_l649)} 筆")
    print(f"今彩539: 新增 {d539_count} 筆，總計 {len(sorted_d539)} 筆")

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        import_from_folder(sys.argv[1])
    else:
        print("Usage: python import_csv_folder.py <folder_path>")
