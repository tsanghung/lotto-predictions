import csv
import os
import requests
import time
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

def download_files():
    csv_path = 'D423F.csv'
    output_dir = '歷史數據'
    
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
        
    with open(csv_path, mode='r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            year = row['資料所屬年度']
            url = row['下載連結'].strip()
            
            if not url:
                continue
                
            # Get filename from URL
            filename = url.split('/')[-1]
            save_path = os.path.join(output_dir, filename)
            
            print(f"正在下載 {year} 年資料: {url} -> {save_path}")
            
            try:
                response = requests.get(url, timeout=30, verify=False)
                response.raise_for_status()
                with open(save_path, 'wb') as out_file:
                    out_file.write(response.content)
                print(f"成功下載 {filename}")
                time.sleep(1)  # Avoid hitting the server too hard
            except Exception as e:
                print(f"下載失敗 {url}: {e}")

if __name__ == "__main__":
    download_files()
