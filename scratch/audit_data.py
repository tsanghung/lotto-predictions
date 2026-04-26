import json
import os
from datetime import datetime, timedelta

def audit_lotto_data():
    l649_path = r'data\lotto649.json'
    d539_path = r'data\daily539.json'
    
    with open(l649_path, 'r', encoding='utf-8') as f:
        l649 = json.load(f)
    with open(d539_path, 'r', encoding='utf-8') as f:
        d539 = json.load(f)

    def check_sequence(data, name, expected_per_year):
        if not data: return
        
        start_date = datetime.strptime(data[0]['date'], '%Y-%m-%d')
        end_date = datetime.strptime(data[-1]['date'], '%Y-%m-%d')
        years = (end_date - start_date).days / 365.25
        
        actual_count = len(data)
        rough_expected = years * expected_per_year
        
        print(f"--- {name} 稽核報告 ---")
        print(f"起始日期: {data[0]['date']} ({data[0]['draw_id']})")
        print(f"結束日期: {data[-1]['date']} ({data[-1]['draw_id']})")
        print(f"涵蓋年數: {years:.2f} 年")
        print(f"實際筆數: {actual_count}")
        print(f"理論預期: 約 {int(rough_expected)} 筆")
        
        # Check for gaps in draw_id (ignoring year prefix)
        gaps = []
        for i in range(len(data)-1):
            curr_id = int(data[i]['draw_id'])
            next_id = int(data[i+1]['draw_id'])
            
            # If same year prefix (first 2 or 3 digits)
            # In Taiwan, 96000001 -> 96 is year.
            curr_year = str(curr_id)[:-6]
            next_year = str(next_id)[:-6]
            
            if curr_year == next_year:
                if next_id - curr_id > 1:
                    gaps.append((data[i]['draw_id'], data[i+1]['draw_id']))
        
        if gaps:
            print(f"偵測到期號斷層: {len(gaps)} 處")
            # Show first 3 gaps
            for g in gaps[:3]:
                print(f"  - 跳號: {g[0]} -> {g[1]}")
        else:
            print("期號序號完整 (無內部跳號)")
        print("\n")

    check_sequence(l649, "大樂透 (Lotto 649)", 110) # 104 regular + CNY
    check_sequence(d539, "今彩 539 (Daily 539)", 312)

if __name__ == "__main__":
    audit_lotto_data()
