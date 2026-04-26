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

def identify_and_import(folder_path):
    l649_path = r'data\lotto649.json'
    d539_path = r'data\daily539.json'
    
    l649_data = {item['draw_id']: item for item in load_json(l649_path)}
    d539_data = {item['draw_id']: item for item in load_json(d539_path)}
    
    l649_count = 0
    d539_count = 0
    
    for root, dirs, files in os.walk(folder_path):
        for filename in files:
            if not filename.lower().endswith(".csv"): continue
            
            csv_file = os.path.join(root, filename)
            is_l649 = False
            is_d539 = False
            working_enc = None
            
            # Identify by Content first
            for enc in ['big5', 'utf-8-sig', 'cp950', 'utf-8']:
                try:
                    with open(csv_file, mode='r', encoding=enc, errors='ignore') as f:
                        line = f.readline()
                        if "大樂透" in line:
                            is_l649 = True
                            working_enc = enc
                            break
                        if "539" in line:
                            is_d539 = True
                            working_enc = enc
                            break
                except:
                    continue
            
            # Identify by Filename if content check failed
            if not (is_l649 or is_d539):
                fn_lower = filename.lower()
                if "539" in fn_lower: 
                    is_d539 = True
                    working_enc = 'big5' # Guess
                if "nj" in fn_lower and "xz" in fn_lower: 
                    is_l649 = True
                    working_enc = 'big5'
            
            if not (is_l649 or is_d539): continue
            
            # Process the file
            try:
                with open(csv_file, mode='r', encoding=working_enc or 'big5', errors='ignore') as f:
                    reader = csv.reader(f)
                    try:
                        header = next(reader)
                    except StopIteration:
                        continue
                        
                    for row in reader:
                        if not row or len(row) < 7: continue
                        
                        draw_id = row[1].strip()
                        if not draw_id or len(draw_id) < 5: continue
                        
                        # Date normalization
                        date_raw = row[2].strip().replace('/', '-')
                        # Ensure YYYY-MM-DD
                        parts = date_raw.split('-')
                        if len(parts) == 3:
                            date = f"{parts[0]}-{parts[1].zfill(2)}-{parts[2].zfill(2)}"
                        else:
                            continue
                        
                        if is_l649:
                            if len(row) < 13: continue
                            if "加開" in row[0]: continue
                            try:
                                numbers = [int(n) for n in row[6:12]]
                                special = int(row[12])
                                if draw_id not in l649_data:
                                    l649_data[draw_id] = {"draw_id": draw_id, "date": date, "numbers": numbers, "special_number": special}
                                    l649_count += 1
                            except: continue
                        elif is_d539:
                            try:
                                numbers = [int(n) for n in row[6:11]]
                                if draw_id not in d539_data:
                                    d539_data[draw_id] = {"draw_id": draw_id, "date": date, "numbers": numbers, "special_number": None}
                                    d539_count += 1
                            except: continue
            except Exception:
                continue # Silent fail for encoding errors to keep moving

    # Final Sort and Save
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
        
    print(f"Mission Result:")
    print(f"Lotto649: Added {l649_count}, Total {len(sorted_l649)}")
    print(f"Daily539: Added {d539_count}, Total {len(sorted_d539)}")

if __name__ == "__main__":
    identify_and_import(r'scratch\temp_all')
