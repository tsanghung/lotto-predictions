import json
import os

def final_539_patch():
    d539_path = r'data\daily539.json'
    d539_data = {item['draw_id']: item for item in json.load(open(d539_path, 'r', encoding='utf-8'))}
    
    patch_data = [
      {"draw_id": "115000081", "date": "2026-04-01", "winning_numbers": ["03", "10", "11", "13", "23"]},
      {"draw_id": "115000082", "date": "2026-04-02", "winning_numbers": ["01", "09", "13", "18", "21"]},
      {"draw_id": "115000083", "date": "2026-04-03", "winning_numbers": ["06", "08", "09", "25", "35"]},
      {"draw_id": "115000084", "date": "2026-04-04", "winning_numbers": ["04", "17", "25", "31", "36"]},
      {"draw_id": "115000085", "date": "2026-04-06", "winning_numbers": ["07", "11", "17", "31", "34"]},
      {"draw_id": "115000086", "date": "2026-04-07", "winning_numbers": ["04", "08", "21", "27", "29"]},
      {"draw_id": "115000087", "date": "2026-04-08", "winning_numbers": ["02", "04", "05", "06", "29"]}
    ]
    
    added = 0
    for item in patch_data:
        draw_id = item['draw_id']
        if draw_id not in d539_data:
            d539_data[draw_id] = {
                "draw_id": draw_id,
                "date": item['date'],
                "numbers": [int(n) for n in item['winning_numbers']],
                "special_number": None
            }
            added += 1
            
    if added > 0:
        with open(d539_path, 'w', encoding='utf-8') as f:
            json.dump(sorted(d539_data.values(), key=lambda x: x['date']), f, ensure_ascii=False, indent=2)
        print(f"成功補齊最後的 {added} 筆今彩 539 缺口！")
    else:
        print("資料庫已是最新狀態。")

if __name__ == "__main__":
    final_539_patch()
