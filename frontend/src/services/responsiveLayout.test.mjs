import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('heatmap cells shrink without widening the mobile viewport', async () => {
  const [historySource, frequencySource, intervalSource] = await Promise.all([
    readFile(new URL('../components/HeatmapChart.vue', import.meta.url), 'utf8'),
    readFile(new URL('../components/HotColdChart.vue', import.meta.url), 'utf8'),
    readFile(new URL('../components/IntervalAnalysis.vue', import.meta.url), 'utf8')
  ])

  assert.match(historySource, /class="heatmap-cell"/)
  assert.match(historySource, /\.heatmap-cell\s*\{[^}]*min-width:\s*0/s)
  assert.match(historySource, /@media\s*\(max-width:\s*640px\)[\s\S]*\.heatmap-number[\s\S]*font-size:\s*16px/)
  assert.match(frequencySource, /class="frequency-cell"/)
  assert.match(frequencySource, /\.frequency-cell\s*\{[^}]*min-width:\s*0/s)
  assert.match(frequencySource, /@media\s*\(max-width:\s*640px\)[\s\S]*\.frequency-number[\s\S]*font-size:\s*16px/)
  assert.match(intervalSource, /class="interval-cell"/)
  assert.match(intervalSource, /\.interval-cell\s*\{[^}]*min-width:\s*0/s)
  assert.match(intervalSource, /@media\s*\(max-width:\s*640px\)[\s\S]*\.interval-number[\s\S]*font-size:\s*16px/)
})
