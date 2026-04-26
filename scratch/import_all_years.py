import os
import zipfile
import shutil
import subprocess

def import_all():
    history_dir = '歷史數據'
    temp_root = r'scratch\temp_all'
    import_script = r'scratch\import_csv_folder.py'
    python_exe = r'venv\Scripts\python.exe'
    
    if os.path.exists(temp_root):
        shutil.rmtree(temp_root)
    os.makedirs(temp_root)
    
    # Years to process
    years = range(2009, 2025)
    
    for year in years:
        zip_path = os.path.join(history_dir, f"{year}.zip")
        if not os.path.exists(zip_path):
            print(f"找不到檔案: {zip_path}，跳過。")
            continue
            
        print(f"--- 正在處理 {year} 年 ---")
        extract_to = os.path.join(temp_root, str(year))
        
        try:
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                zip_ref.extractall(extract_to)
            
            # Find the subfolders (like 98, 99, etc.)
            subdirs = [os.path.join(extract_to, d) for d in os.listdir(extract_to) if os.path.isdir(os.path.join(extract_to, d))]
            
            if not subdirs:
                # If no subfolder, the CSVs might be in the root
                target_folder = extract_to
            else:
                target_folder = subdirs[0]
                
            # Run the import script
            print(f"導入資料夾: {target_folder}")
            subprocess.run([python_exe, import_script, target_folder], check=True)
            
        except Exception as e:
            print(f"{year} 年處理出錯: {e}")

    print("\n✅ 所有年度導入完成！")

if __name__ == "__main__":
    import_all()
