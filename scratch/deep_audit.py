import json
import os

def check_data_integrity():
    files = {
        "Lotto 649": r'data\lotto649.json',
        "Daily 539": r'data\daily539.json'
    }
    
    for name, path in files.items():
        if not os.path.exists(path): continue
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if not data: continue
            
        year_groups = {}
        for item in data:
            draw_id_str = item['draw_id']
            draw_year = draw_id_str[:-6]
            draw_num = int(draw_id_str[-6:])
            if draw_year not in year_groups: year_groups[draw_year] = []
            year_groups[draw_year].append(draw_num)
            
        print(f"=== {name} Audit ===")
        sorted_years = sorted(year_groups.keys(), key=lambda x: int(x))
        print(f"{'Year':<6} | {'Start':<8} | {'End':<8} | {'Exp':<8} | {'Act':<8} | {'Status'}")
        print("-" * 60)
        
        for year in sorted_years:
            nums = sorted(year_groups[year])
            start_num, end_num = nums[0], nums[-1]
            actual, theoretical = len(nums), end_num - start_num + 1
            diff = theoretical - actual
            status = "OK" if diff == 0 else f"MISSING {diff}"
            print(f"{year:<6} | {start_num:<8} | {end_num:<8} | {theoretical:<8} | {actual:<8} | {status}")
        print("-" * 60)
        print("\n")

if __name__ == "__main__":
    check_data_integrity()
