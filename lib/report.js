// 汇总：把 armor 的所有切卷读成一份可读报告
//
// 用途：A/B 前的基线、切 scrubMode 前的证据。纯函数，输入是 readArmorRecords 的记录数组。

const DAY = 86400000;

function dayOf(ts) {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return "unknown";
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * @param {Array<object>} records readArmorRecords() 的结果
 * @param {{days?:number, now?:number}} opts 只看最近 N 天的趋势（verdict 统计仍用全量）
 */
export function summarizeRecords(records, opts = {}) {
  const days = Number.isFinite(opts.days) ? opts.days : 7;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const cutoff = now - days * DAY;

  const out = {
    records: 0,
    files: new Set(),
    turns: 0,
    combined: { pass: 0, refusal: 0, fallback: 0 },
    keyword: { pass: 0, refusal: 0, fallback: 0 },
    conflicts: 0,
    assemblies: 0,
    injected: 0,
    hellos: 0,
    alarms: 0,
    lastAlarm: null,
    scrub: {},
    shadow: {},
    presets: {},
    models: {},
    days: [],
  };
  const byDay = new Map();
  const bump = (map, key, n = 1) => { if (key) map[key] = (map[key] || 0) + n; };

  for (const rec of records) {
    out.records += 1;
    if (rec._file) out.files.add(rec._file);
    if (rec.type === "assembly") {
      out.assemblies += 1;
      if (rec.injected) out.injected += 1;
      for (const hit of rec.scrub || []) bump(out.scrub, hit.id, hit.count || 1);
      for (const hit of rec.shadow || []) bump(out.shadow, hit.id, hit.count || 1);
      continue;
    }
    if (rec.type === "hello") { out.hellos += 1; continue; }
    if (rec.type === "alarm") {
      out.alarms += 1;
      if (!out.lastAlarm || Date.parse(rec.ts) > Date.parse(out.lastAlarm)) out.lastAlarm = rec.ts;
      continue;
    }
    if (!rec.verdict) continue;
    out.turns += 1;
    bump(out.keyword, rec.verdict);
    const m = rec.model || "unknown";
    const bucketM = out.models[m] || (out.models[m] = { turns: 0, pass: 0, refusal: 0, fallback: 0 });
    bucketM.turns += 1;
    const mv = rec.combined ?? rec.verdict;
    if (mv in bucketM) bucketM[mv] += 1;
    const p = rec.preset || "unknown";
    const bucketP = out.presets[p] || (out.presets[p] = { turns: 0, pass: 0, refusal: 0, fallback: 0 });
    bucketP.turns += 1;
    const pv = rec.combined ?? rec.verdict;
    if (pv in bucketP) bucketP[pv] += 1;
    bump(out.combined, rec.combined ?? rec.verdict);
    if (rec.conflict === true) out.conflicts += 1;
    for (const hit of rec.scrub || []) bump(out.scrub, hit.id, hit.count || 1);

    const ms = Date.parse(rec.ts);
    if (Number.isFinite(ms) && ms >= cutoff) {
      const day = dayOf(rec.ts);
      const bucket = byDay.get(day) || { day, turns: 0, pass: 0, refusal: 0, fallback: 0, conflicts: 0 };
      bucket.turns += 1;
      const v = rec.combined ?? rec.verdict;
      if (v in bucket) bucket[v] += 1;
      if (rec.conflict === true) bucket.conflicts += 1;
      byDay.set(day, bucket);
    }
  }

  out.days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  out.files = [...out.files];
  return out;
}

const topN = (map, n = 5) => Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n)
  .map(([id, count]) => `${id}×${count}`).join(" ") || "-";

/** 压成工具可读的文本 */
export function formatReport(summary, { host = null, scrubMode = null } = {}) {
  const head = [
    `files: ${summary.files.length} | records: ${summary.records} (verdict ${summary.turns} / assembly ${summary.assemblies} / hello ${summary.hellos} / alarm ${summary.alarms})`,
    `turns: ${summary.turns}`,
    `combined: pass=${summary.combined.pass} refusal=${summary.combined.refusal} fallback=${summary.combined.fallback}`,
    `keyword : pass=${summary.keyword.pass} refusal=${summary.keyword.refusal} fallback=${summary.keyword.fallback}`,
    `conflicts: ${summary.conflicts}${summary.turns ? `（${(summary.conflicts / summary.turns * 100).toFixed(1)}%）` : ""}`,
    `assembly: injected=${summary.injected}/${summary.assemblies}`,
    `alarm: ${summary.alarms}${summary.lastAlarm ? `（最近 ${summary.lastAlarm}）` : ""}`,
    `scrub : ${topN(summary.scrub)}`,
    `shadow: ${topN(summary.shadow)}`,
    host ? `host: ${host}` : null,
    scrubMode ? `scrubMode: ${scrubMode}` : null,
  ].filter(Boolean);
  const models = Object.entries(summary.models || {}).map(([m, v]) => `  ${m}: turns=${v.turns} pass=${v.pass} refusal=${v.refusal} fallback=${v.fallback}`);
  const presets = Object.entries(summary.presets || {}).map(([p, v]) => `  ${p}: turns=${v.turns} pass=${v.pass} refusal=${v.refusal} fallback=${v.fallback}`);
  const days = summary.days.map((d) => `  ${d.day} turns=${d.turns} pass=${d.pass} refusal=${d.refusal} fallback=${d.fallback} conflicts=${d.conflicts}`);
  return [...head, ...(models.length ? ["models:", ...models] : []), ...(presets.length ? ["presets:", ...presets] : []), ...(days.length ? ["days:", ...days] : ["days: -"])].join("\n");
}
