// 运行时变量切换 + 按变量分桶
//
// 目的：做受控 A/B 时不想每次都重启宿主。插件把"当前用哪个变体"记进账本
// （type:"variant"），分析时按记录时间回放时间线，把每条 verdict 归到当时生效的变体。
// 这样 ABBA 交替也能正确归属，不依赖"记住几点切的"。

/** 变体记录 → 时间线（按时间升序） */
export function variantTimeline(records, { key = "lead" } = {}) {
  return records
    .filter((r) => r && r.type === "variant" && r[key] !== undefined)
    .map((r) => ({ at: Date.parse(r.ts), value: String(r[key]), preset: r.preset ?? null }))
    .filter((v) => Number.isFinite(v.at))
    .sort((a, b) => a.at - b.at);
}

/** 某时刻生效的变体值；时间线之前返回 null */
export function variantAt(timeline, ts, preset = null) {
  let current = null;
  for (const item of timeline) {
    if (item.at > ts) break;
    if (preset && item.preset && item.preset !== preset) continue;
    current = item.value;
  }
  return current;
}

/**
 * 按变体把 verdict 记录分成两桶（值 = 时间线里出现过的两个值）。
 * @returns {{values:[string,string], a:Array, b:Array, timeline:Array, untagged:number}}
 */
export function splitByVariant(records, { key = "lead", preset = null, from = -Infinity, to = Infinity } = {}) {
  const timeline = variantTimeline(records, { key });
  const values = [...new Set(timeline.map((v) => v.value))];
  const a = [];
  const b = [];
  let untagged = 0;
  if (values.length < 2) return { values, a, b, timeline, untagged };
  const [first, second] = values;
  for (const rec of records) {
    if (!rec || !rec.verdict) continue;
    if (preset && rec.preset !== preset) continue;
    const ms = Date.parse(rec.ts);
    if (!Number.isFinite(ms) || ms < from || ms > to) continue;
    const value = variantAt(timeline, ms, preset);
    if (value === null) { untagged += 1; continue; }
    if (value === first) a.push(rec);
    else if (value === second) b.push(rec);
  }
  return { values, a, b, timeline, untagged };
}
