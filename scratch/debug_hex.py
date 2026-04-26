import os

def debug_hex():
    # Pick a sample file from 2018
    sample = r'scratch\temp_all\2018\2018'
    if not os.path.exists(sample): return
    files = [f for f in os.listdir(sample) if f.endswith('.csv')]
    
    for filename in files:
        path = os.path.join(sample, filename)
        try:
            with open(path, 'rb') as f:
                data = f.read(50)
                # Use ascii(filename) to avoid print errors
                print(f"File: {ascii(filename)}")
                print(f"Hex: {data.hex(' ')}")
                print("-" * 30)
        except: pass

if __name__ == "__main__":
    debug_hex()
