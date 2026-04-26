import json
import os

def find_missing_numbers():
    path = r'data\daily539.json'
    if not os.path.exists(path): return
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    year_115_nums = []
    for item in data:
        if item['draw_id'].startswith('115'):
            year_115_nums.append(int(item['draw_id'][-6:]))
    
    year_115_nums.sort()
    if not year_115_nums: return
    
    start, end = year_115_nums[0], year_115_nums[-1]
    all_nums = set(range(start, end + 1))
    missing = sorted(list(all_nums - set(year_115_nums)))
    
    print(f"2026 年 (115) 缺少的今彩 539 期號: {missing}")

if __name__ == "__main__":
    find_missing_numbers()
