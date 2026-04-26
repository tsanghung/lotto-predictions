import json
import numpy as np
from collections import Counter
import os

def advanced_analysis():
    with open('data/daily539.json', 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    all_draws = [item['numbers'] for item in data]
    flat_list = [num for draw in all_draws for num in draw]
    total_draws = len(all_draws)
    
    counts = Counter(flat_list)
    hot_numbers = sorted(counts.items(), key=lambda x: x[1], reverse=True)
    
    recent_flat = [num for draw in all_draws[-120:] for num in draw]
    recent_counts = Counter(recent_flat)
    recent_hot = sorted(recent_counts.items(), key=lambda x: x[1], reverse=True)
    
    last_appearance = {}
    for n in range(1, 40): last_appearance[n] = total_draws
    for i, draw in enumerate(reversed(all_draws)):
        for num in draw:
            if last_appearance[num] == total_draws:
                last_appearance[num] = i
    missing_values = sorted(last_appearance.items(), key=lambda x: x[1], reverse=True)
    
    last_draw = all_draws[-1]
    last_draw_date = data[-1]['date']
    
    next_corr = {} 
    for i in range(len(all_draws) - 1):
        prev_draw = all_draws[i]
        next_draw = all_draws[i+1]
        for p in prev_draw:
            if p not in next_corr: next_corr[p] = Counter()
            next_corr[p].update(next_draw)
            
    likely_followers = Counter()
    for num in last_draw:
        if num in next_corr:
            likely_followers.update(next_corr[num])
            
    sim_results = Counter()
    weights = np.zeros(40)
    for n in range(1, 40):
        w = (counts[n] / total_draws * 30) + (recent_counts[n] / 120 * 50)
        gap = last_appearance.get(n, 0)
        if 5 <= gap <= 15: w += 2.0
        elif gap > 30: w += 1.0
        if n in [x[0] for x in likely_followers.most_common(10)]:
            w += 1.5
        weights[n] = max(0.1, w)
    
    prob = weights[1:] / weights[1:].sum()
    
    for _ in range(50000):
        sim_draw = np.random.choice(range(1, 40), 5, replace=False, p=prob)
        sim_results[tuple(sorted([int(x) for x in sim_draw]))] += 1
        
    top_simulated = sorted(sim_results.items(), key=lambda x: x[1], reverse=True)[:5]
    
    last_50_sums = [sum(d) for d in all_draws[-50:]]
    avg_sum = sum(last_50_sums) / 50
    
    analysis = {
        "analysis_date": "2026-04-26",
        "last_draw": {"date": last_draw_date, "numbers": last_draw},
        "statistics": {
            "hot_long_term": [[int(x[0]), int(x[1])] for x in hot_numbers[:8]],
            "hot_short_term": [[int(x[0]), int(x[1])] for x in recent_hot[:8]],
            "overdue_numbers": [[int(x[0]), int(x[1])] for x in missing_values if x[1] > 20][:5],
            "correlation_candidates": [[int(x[0]), int(x[1])] for x in likely_followers.most_common(8)]
        },
        "trends": {
            "average_sum_target": round(avg_sum, 2),
            "suggested_odd_even": "3:2 or 2:3"
        },
        "monte_carlo_predictions": [
            {"numbers": [int(x) for x in list(c)], "confidence_score": int(count)} for c, count in top_simulated
        ]
    }
    
    print(json.dumps(analysis, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    advanced_analysis()
