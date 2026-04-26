import json
import os

def import_scraped_539():
    d539_path = r'data\daily539.json'
    d539_data = {item['draw_id']: item for item in json.load(open(d539_path, 'r', encoding='utf-8'))}
    
    # Scraped data from subagent
    scraped = [
      {"draw_id": "115000102", "draw_date": "115/04/25", "winning_numbers": ["03", "20", "21", "22", "33"]},
      {"draw_id": "115000101", "draw_date": "115/04/24", "winning_numbers": ["16", "21", "25", "29", "34"]},
      {"draw_id": "115000100", "draw_date": "115/04/23", "winning_numbers": ["02", "10", "17", "25", "35"]},
      {"draw_id": "115000099", "draw_date": "115/04/22", "winning_numbers": ["05", "07", "24", "38", "39"]},
      {"draw_id": "115000098", "draw_date": "115/04/21", "winning_numbers": ["01", "06", "14", "26", "28"]},
      {"draw_id": "115000097", "draw_date": "115/04/20", "winning_numbers": ["03", "04", "05", "20", "36"]},
      {"draw_id": "115000096", "draw_date": "115/04/18", "winning_numbers": ["07", "25", "26", "29", "31"]},
      {"draw_id": "115000095", "draw_date": "115/04/17", "winning_numbers": ["01", "02", "07", "16", "26"]},
      {"draw_id": "115000094", "draw_date": "115/04/16", "winning_numbers": ["06", "08", "12", "21", "30"]},
      {"draw_id": "115000093", "draw_date": "115/04/15", "winning_numbers": ["02", "09", "11", "29", "30"]},
      {"draw_id": "115000092", "draw_date": "115/04/14", "winning_numbers": ["09", "14", "27", "29", "33"]},
      {"draw_id": "115000091", "draw_date": "115/04/13", "winning_numbers": ["18", "30", "31", "37", "38"]},
      {"draw_id": "115000090", "draw_date": "115/04/11", "winning_numbers": ["07", "12", "17", "24", "31"]},
      {"draw_id": "115000089", "draw_date": "115/04/10", "winning_numbers": ["09", "21", "25", "27", "30"]},
      {"draw_id": "115000088", "draw_date": "115/04/09", "winning_numbers": ["02", "15", "25", "31", "38"]}
    ]
    
    added = 0
    for item in scraped:
        draw_id = item['draw_id']
        if draw_id not in d539_data:
            # Convert 115/04/25 to 2026-04-25
            parts = item['draw_date'].split('/')
            year = int(parts[0]) + 1911
            date = f"{year}-{parts[1]}-{parts[2]}"
            
            d539_data[draw_id] = {
                "draw_id": draw_id,
                "date": date,
                "numbers": [int(n) for n in item['winning_numbers']],
                "special_number": None
            }
            added += 1
            
    if added > 0:
        with open(d539_path, 'w', encoding='utf-8') as f:
            json.dump(sorted(d539_data.values(), key=lambda x: x['date']), f, ensure_ascii=False, indent=2)
        print(f"成功匯入 {added} 筆今彩 539 資料！")
    else:
        print("沒有新資料需要匯入。")

if __name__ == "__main__":
    import_scraped_539()
