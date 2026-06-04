<script setup>
defineProps({
  label: { type: String, default: '' },     // 英文小標 (eyebrow)
  title: { type: String, required: true },   // 中文主標題
  desc: { type: String, default: '' },       // 選填說明
  accent: { type: String, default: '#2dd4bf' }
})
</script>

<template>
  <div style="margin-bottom:24px;">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
      <span :style="{ width:'28px', height:'3px', borderRadius:'3px', background: accent }"></span>
      <span style="font-size:0.72rem;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:#64748b;">
        {{ label }}
      </span>
    </div>
    <h2 style="font-size:1.5rem;font-weight:800;color:#e2e8f0;margin:0;line-height:1.3;">
      {{ title }}
    </h2>
    <p v-if="desc" style="font-size:0.9rem;color:#64748b;margin:6px 0 0;line-height:1.5;">
      {{ desc }}
    </p>
  </div>
</template>
