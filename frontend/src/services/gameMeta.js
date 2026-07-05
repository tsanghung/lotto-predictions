// 各彩種「特殊球」的正確定位（避免把大樂透的特別號誤稱為第二區）。
// - 大樂透：特別號——從同一 1~49 號池抽出的第 7 顆球，不是獨立區，本站也不預測它。
// - 威力彩：第二區——獨立的 1~8 號池，本站會預測並評估其命中率。
// - 今彩539：無特殊球。
const SPECIAL_AREA = {
  '大樂透': { label: '特別號', predicted: false },
  '威力彩': { label: '第二區', predicted: true },
}

// 該彩種特殊球的正確名稱；無特殊球回傳 null。
export function specialAreaLabel(gameName) {
  return SPECIAL_AREA[gameName]?.label ?? null
}

// 該彩種的特殊球是否納入本站選號預測與命中率評估（僅威力彩第二區）。
// 大樂透雖有特別號，但本站不預測它，故不應顯示其「預測命中率」。
export function predictsSpecialArea(gameName) {
  return SPECIAL_AREA[gameName]?.predicted ?? false
}
