// A/B 比对：把 armor 账本按时间点切成两段，比较"坏轮次"（refusal + fallback）比例
//
// 用途：改一次注入参数（例如 lead=true/false），跑够样本后回答"到底有没有变"。
// 只读账本，不参与注入。

import { splitByVariant, variantTimeline, variantAt } from "./variant.js";

const DAY = 86400000;

/**
 * 账本级去重：0.20.0 之前没有 digest，同一条消息的多次触发只能靠"同预设 + 同长度 + 相邻"近似。
 * @param {Array} records
 * @param {"auto"|"digest"|"none"} mode auto = 有 digest 用 digest，没有才用相邻同长
 */
export function dedupeRecords(records, mode = "auto") {
  if (mode === "none") return records.slice();
  const sorted = records.slice().sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
  const out = [];
  let prev = null;
  for (const rec of sorted) {
    if (!rec || !rec.verdict) { out.push(rec); prev = null; continue; }
    // 两边都有 digest 时以 digest 为准（不同就保留，可能是改写）；
    // 只有缺 digest 的旧记录才退化为"同预设 + 同长度 + 相邻"。
    const sameAsPrev = prev
      && prev.verdict
      && prev.preset === rec.preset
      && prev.len === rec.len
      && (rec.digest && prev.digest ? rec.digest === prev.digest : true);
    if (sameAsPrev) continue;
    out.push(rec);
    prev = rec;
  }
  return out;
}

/** 两比例 z 检验（合并方差），返回 z 值与双侧 p 的粗略判定。a/b 需带 hits 与 turns */
export function twoProportionZ(a, b) {
  const n1 = a.turns, n2 = b.turns;
  if (!n1 || !n2) return { z: 0, p: 1 };
  const p1 = a.hits / n1;
  const p2 = b.hits / n2;
  const pooled = (a.hits + b.hits) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (!se) return { z: 0, p: 1 };
  const z = (p2 - p1) / se;
  // 正态近似：|z|>=1.96 ≈ p<0.05，>=2.58 ≈ p<0.01
  const p = z === 0 ? 1 : 2 * (1 - normalCdf(Math.abs(z)));
  return { z, p };
}

/** Welch t 检验（用于对数长度这类连续量），返回 t 与双侧 p 的近似 */
export function welchT(xs, ys) {
  const clean = (v) => v.filter((x) => Number.isFinite(x) && x > 0).map((x) => Math.log(x));
  const a = clean(xs), b = clean(ys);
  if (a.length < 2 || b.length < 2) return { t: 0, p: 1 };
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const varc = (v, m) => v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1);
  const ma = mean(a), mb = mean(b);
  const va = varc(a, ma) / a.length, vb = varc(b, mb) / b.length;
  const se = Math.sqrt(va + vb);
  if (!se) return { t: 0, p: 1 };
  const t = (mb - ma) / se;
  return { t, p: 2 * (1 - normalCdf(Math.abs(t))) };
}

function normalCdf(x) {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - prob : prob;
}

const BANDS = [[0, 500], [500, 1000], [1000, 2000], [2000, Infinity]];

/** 按输出长度分层的命中率：用来判断聚合差异有多少来自"任务变重" */
export function lengthBands(records, { from, to, preset = null, metric = "bad", byVariantValues = null } = {}) {
  const timeline = byVariantValues ? variantTimeline(records) : null;
  const rows = [];
  for (const [lo, hi] of BANDS) {
    const row = { band: `${lo}-${hi === Infinity ? "inf" : hi}`, a: { turns: 0, hits: 0 }, b: { turns: 0, hits: 0 } };
    for (const rec of records) {
      if (!rec || !rec.verdict) continue;
      if (preset && rec.preset !== preset) continue;
      const len = rec.len || 0;
      if (len < lo || len >= hi) continue;
      const ms = Date.parse(rec.ts);
      if (!Number.isFinite(ms)) continue;
      let side;
      if (byVariantValues) {
        const value = variantAt(timeline, ms, preset);
        side = value === byVariantValues[0] ? "a" : value === byVariantValues[1] ? "b" : null;
      } else {
        side = ms < from ? "a" : ms < to ? "b" : null;
      }
      if (!side) continue;
      const hit = metric === "deliverable"
        ? (rec.structure === "deliverable" || rec.structure === "mixed")
        : ["refusal", "fallback"].includes(rec.combined ?? rec.verdict);
      row[side].turns += 1;
      if (hit) row[side].hits += 1;
    }
    if (row.a.turns || row.b.turns) rows.push(row);
  }
  return rows;
}

function bucket(records, from, to, preset = null, metric = "bad") {
  const out = { turns: 0, hits: 0, bad: 0, refusal: 0, fallback: 0, pass: 0, deliverable: 0, lengths: [] };
  for (const rec of records) {
    if (!rec || !rec.verdict) continue;
    if (preset && rec.preset !== preset) continue;
    const ms = Date.parse(rec.ts);
    if (!Number.isFinite(ms)) continue;
    if (ms < from || ms >= to) continue;
    out.turns += 1;
    const v = rec.combined ?? rec.verdict;
    if (v === "refusal") { out.refusal += 1; out.bad += 1; }
    else if (v === "fallback") { out.fallback += 1; out.bad += 1; }
    else out.pass += 1;
    if (rec.structure === "deliverable" || rec.structure === "mixed") out.deliverable += 1;
    out.lengths = out.lengths || [];
    if (rec.len) out.lengths.push(rec.len);
  }
  out.badRate = out.turns ? out.bad / out.turns : 0;
  out.deliverableRate = out.turns ? out.deliverable / out.turns : 0;
  out.hits = metric === "deliverable" ? out.deliverable : out.bad;
  out.rate = out.turns ? out.hits / out.turns : 0;
  return out;
}

/**
 * @param {Array<object>} records readArmorRecords() 的输出
 * @param {{splitAt:string, windowDays?:number, minTurns?:number, now?:number}} opts
 */
export function compareWindows(records, opts = {}) {
  records = dedupeRecords(records, opts.dedupe ?? "none");
  if (opts.since || opts.until) {
    const lo = opts.since ? Date.parse(opts.since) : -Infinity;
    const hi = opts.until ? Date.parse(opts.until) : Infinity;
    records = records.filter((r) => {
      const ms = Date.parse(r.ts);
      return Number.isFinite(ms) ? ms >= lo && ms <= hi : false;
    });
  }
  if (opts.byVariant) return compareByVariant(records, opts);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const days = Number.isFinite(opts.windowDays) ? opts.windowDays : 14;
  const minTurns = Number.isFinite(opts.minTurns) ? opts.minTurns : 200;
  const splitMs = Date.parse(opts.splitAt);
  if (!Number.isFinite(splitMs)) throw new Error(`splitAt 不是合法时间: ${opts.splitAt}`);
  const span = days * DAY;
  const preset = opts.preset ? String(opts.preset) : null;
  const metric = opts.metric === "deliverable" ? "deliverable" : "bad";
  const a = bucket(records, splitMs - span, splitMs, preset, metric);
  const b = bucket(records, splitMs, Math.min(now, splitMs + span), preset, metric);
  const { z, p } = twoProportionZ(a, b);
  const enough = a.turns >= minTurns && b.turns >= minTurns;
  const significant = enough && Math.abs(z) >= 1.96;
  const delta = b.rate - a.rate;
  // 方向：坏率越低越好；成品率越高越好
  const better = metric === "deliverable" ? delta > 0 : delta < 0;
  let note = "";
  if (!a.turns || !b.turns) note = `${!a.turns ? "A" : "B"} 侧该预设没有样本（打标从 0.15.0 起才有）`;
  else if (!enough) note = `样本不足（A=${a.turns} / B=${b.turns}，下限 ${minTurns}）`;
  else if (!significant) note = "差异不显著";
  else note = better
    ? (metric === "deliverable" ? "B 侧更好（成品率上升，显著）" : "B 侧更好（坏率下降，显著）")
    : (metric === "deliverable" ? "B 侧更差（成品率下降，显著）" : "B 侧更差（坏率上升，显著）");
  const bands = lengthBands(records, { from: splitMs - span, to: Math.min(now, splitMs + span), preset, metric });
  return { splitAt: new Date(splitMs).toISOString(), windowDays: days, preset, metric, a, b, delta, z, p, enough, significant, note, bands };
}

/**
 * 按账本里的变体记录分桶（ABBA 交替也成立）。
 * A = 时间线里第一个变体值，B = 第二个；其余并入 A/B 之外忽略。
 */
export function compareByVariant(records, opts = {}) {
  const preset = opts.preset ? String(opts.preset) : null;
  const metric = ["deliverable", "length", "codeblocks"].includes(opts.metric) ? opts.metric : "bad";
  const minTurns = Number.isFinite(opts.minTurns) ? opts.minTurns : 200;
  const split = splitByVariant(records, { preset });
  let { values, a, b, untagged } = split;
  if (values.length === 2 && values[0] === "true" && values[1] === "false") {
    values = ["false", "true"];
    [a, b] = [b, a];
  }
  const count = (arr) => {
    const out = { turns: arr.length, hits: 0, bad: 0, refusal: 0, fallback: 0, pass: 0, deliverable: 0, lengths: [] };
    for (const rec of arr) {
      const v = rec.combined ?? rec.verdict;
      if (v === "refusal") { out.refusal += 1; out.bad += 1; }
      else if (v === "fallback") { out.fallback += 1; out.bad += 1; }
      else out.pass += 1;
      if (rec.structure === "deliverable" || rec.structure === "mixed") out.deliverable += 1;
      if (rec.len) out.lengths.push(rec.len);
    }
    out.badRate = out.turns ? out.bad / out.turns : 0;
    out.deliverableRate = out.turns ? out.deliverable / out.turns : 0;
    out.hits = metric === "deliverable" ? out.deliverable : out.bad;
    out.rate = out.turns ? out.hits / out.turns : 0;
    return out;
  };
  const A = count(a);
  const B = count(b);
  if (metric === "codeblocks") {
    const pick = (arr) => arr.map((r) => (r.signals && Number(r.signals.codeBlocks)) || 0);
    const xs = pick(a), ys = pick(b);
    const mean = (v) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0);
    const { t, p } = welchT(xs.map((x) => x + 1), ys.map((y) => y + 1));
    const enoughC = A.turns >= minTurns / 4 && B.turns >= minTurns / 4;
    return {
      mode: "byVariant", values, preset, metric,
      a: { ...A, mean: Number(mean(xs).toFixed(2)) }, b: { ...B, mean: Number(mean(ys).toFixed(2)) },
      delta: Number((mean(ys) - mean(xs)).toFixed(2)), z: t, p,
      enough: enoughC, significant: enoughC && Math.abs(t) >= 1.96,
      note: !enoughC ? "样本太少" : Math.abs(t) >= 1.96 ? (t > 0 ? "B 代码块更多（显著）" : "B 代码块更少（显著）") : "代码块数量差异不显著",
      untagged, bands: [],
    };
  }
  if (metric === "length") {
    const { t, p } = welchT(A.lengths, B.lengths);
    const mean = (v) => (v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : 0);
    const enoughL = A.turns >= minTurns / 4 && B.turns >= minTurns / 4;
    return {
      mode: "byVariant", values, preset, metric,
      a: { ...A, mean: mean(A.lengths) }, b: { ...B, mean: mean(B.lengths) },
      delta: mean(B.lengths) - mean(A.lengths), z: t, p,
      enough: enoughL, significant: enoughL && Math.abs(t) >= 1.96,
      note: !enoughL ? "样本太少" : Math.abs(t) >= 1.96 ? (t > 0 ? "B 更长（显著）" : "B 更短（显著）") : "长度差异不显著",
      untagged, bands: [],
    };
  }
  const { z, p } = twoProportionZ(A, B);
  const enough = A.turns >= minTurns && B.turns >= minTurns;
  const significant = enough && Math.abs(z) >= 1.96;
  const delta = B.rate - A.rate;
  const better = metric === "deliverable" ? delta > 0 : delta < 0;
  let note;
  if (values.length < 2) note = "账本里还没有两个变体，先用 compose_variant 切一次";
  else if (!A.turns || !B.turns) note = "有一侧没有样本";
  else if (!enough) note = `样本不足（A=${A.turns} / B=${B.turns}，下限 ${minTurns}）`;
  else if (!significant) note = "差异不显著";
  else note = better ? "B 侧更好（显著）" : "B 侧更差（显著）";
  return {
    mode: "byVariant",
    values,
    preset,
    metric,
    a: A,
    b: B,
    delta,
    z,
    p,
    enough,
    significant,
    note,
    untagged,
    bands: lengthBands(records, { from: -Infinity, to: Infinity, preset, metric, byVariantValues: values }),
  };
}

/** 压成工具可读文本 */
export function formatComparison(c) {
  const pct = (v) => `${(v * 100).toFixed(2)}%`;
  return [
    c.mode === "byVariant"
      ? `分桶: 按账本变体记录（A=${c.values[0]} / B=${c.values[1] ?? "?"}${c.preset ? `，只看 preset=${c.preset}` : ""}，未归属 ${c.untagged} 条）`
      : `split: ${c.splitAt}（窗口 ±${c.windowDays} 天${c.preset ? `，只看 preset=${c.preset}` : "，全部预设"}）`,
    `metric: ${c.metric === "deliverable" ? "成品率（structure=deliverable|mixed）" : "坏率（refusal+fallback）"}`,
    `A: turns=${c.a.turns} bad=${c.a.bad} deliverable=${c.a.deliverable} → rate ${pct(c.a.rate)}`,
    `B: turns=${c.b.turns} bad=${c.b.bad} deliverable=${c.b.deliverable} → rate ${pct(c.b.rate)}`,
    `delta: ${(c.delta * 100).toFixed(2)}pp | z=${c.z.toFixed(2)} p≈${c.p.toFixed(3)} | ${c.significant ? "显著" : "不显著"}`,
    `note: ${c.note}`,
    ...(c.bands && c.bands.length ? [
      "bands（同长度区间内比较，剔除任务变重的影响）:",
      ...c.bands.map((row) => {
        const pct = (x) => (x.turns ? `${x.hits}/${x.turns} (${(x.hits / x.turns * 100).toFixed(0)}%)` : "0/0 (-)");
        return `  ${row.band.padEnd(9)} A ${pct(row.a)}   B ${pct(row.b)}`;
      }),
    ] : []),
  ].join("\n");
}
