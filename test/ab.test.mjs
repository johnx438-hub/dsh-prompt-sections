import test from "node:test";
import assert from "node:assert/strict";
import {twoProportionZ, compareWindows, formatComparison, dedupeRecords, welchT } from "../lib/ab.js";

const now = Date.parse("2026-11-10T00:00:00Z");
const split = "2026-11-05T00:00:00Z";
const at = (iso, n, bad = 0) => Array.from({ length: n }, (_, i) => ({
  ts: new Date(Date.parse(iso) + i * 1000).toISOString(),
  verdict: i < bad ? "refusal" : "pass",
  combined: i < bad ? "refusal" : "pass",
}));

test("z 检验：样本相同比例时 z=0", () => {
  const r = twoProportionZ({ turns: 100, hits: 5 }, { turns: 100, hits: 5 });
  assert.equal(r.z, 0);
  assert.ok(r.p > 0.9);
});

test("z 检验：比例大幅下降判显著", () => {
  const a = { turns: 500, hits: 50 };
  const b = { turns: 500, hits: 5 };
  const r = twoProportionZ(a, b);
  assert.ok(r.z < -2);
  assert.ok(r.p < 0.05);
});

test("窗口比对：只统计各自窗口内的记录", () => {
  const records = [...at("2026-11-04T00:00:00Z", 300, 30), ...at("2026-11-06T00:00:00Z", 300, 3)];
  const c = compareWindows(records, { splitAt: split, windowDays: 2, minTurns: 100, now });
  assert.equal(c.a.turns, 300);
  assert.equal(c.b.turns, 300);
  assert.ok(c.a.rate > c.b.rate);
  assert.equal(c.significant, true);
  assert.match(c.note, /下降|更好/);
});

test("窗口比对：样本不足时明确说出来", () => {
  const records = [...at("2026-11-04T00:00:00Z", 10), ...at("2026-11-06T00:00:00Z", 10)];
  const c = compareWindows(records, { splitAt: split, windowDays: 2, minTurns: 200, now });
  assert.equal(c.enough, false);
  assert.match(c.note, /样本不足/);
});

test("窗口比对：没有变化时判不显著", () => {
  const records = [...at("2026-11-04T00:00:00Z", 400, 4), ...at("2026-11-06T00:00:00Z", 400, 4)];
  const c = compareWindows(records, { splitAt: split, windowDays: 2, minTurns: 100, now });
  assert.equal(c.significant, false);
  assert.match(c.note, /不显著/);
});

test("窗口比对：非法 split 抛错", () => {
  assert.throws(() => compareWindows([], { splitAt: "不是时间" }), /splitAt/);
});

test("格式化：四行结论", () => {
  const c = compareWindows([...at("2026-11-04T00:00:00Z", 300), ...at("2026-11-06T00:00:00Z", 300)], { splitAt: split, windowDays: 2, minTurns: 100, now });
  const text = formatComparison(c);
  assert.match(text, /^split:/);
  assert.match(text, /A: turns=300/);
  assert.match(text, /delta: /);
});

test("按 preset 过滤：只统计该预设的轮次", () => {
  const mk = (preset, n, bad) => Array.from({ length: n }, (_, i) => ({
    ts: new Date(Date.parse("2026-11-04T00:00:00Z") + i * 1000).toISOString(),
    preset,
    verdict: i < bad ? "refusal" : "pass",
    combined: i < bad ? "refusal" : "pass",
  }));
  const records = [...mk("cold-deep-scout", 100, 10), ...mk("unrestricted", 400, 40)];
  const all = compareWindows(records, { splitAt: split, windowDays: 3, minTurns: 50, now });
  const only = compareWindows(records, { splitAt: split, windowDays: 3, minTurns: 50, now, preset: "cold-deep-scout" });
  assert.equal(all.a.turns, 500);
  assert.equal(only.a.turns, 100);
  assert.match(formatComparison(only), /只看 preset=cold-deep-scout/);
});

test("metric=deliverable：看成品率，方向反着判", () => {
  const mk = (iso, n, good) => Array.from({ length: n }, (_, i) => ({
    ts: new Date(Date.parse(iso) + i * 1000).toISOString(),
    verdict: "pass",
    combined: "pass",
    structure: i < good ? "deliverable" : "prose",
  }));
  const records = [...mk("2026-11-04T00:00:00Z", 200, 20), ...mk("2026-11-06T00:00:00Z", 200, 80)];
  const c = compareWindows(records, { splitAt: split, windowDays: 2, minTurns: 100, now, metric: "deliverable" });
  assert.equal(c.metric, "deliverable");
  assert.equal(c.a.deliverable, 20);
  assert.equal(c.b.deliverable, 80);
  assert.ok(c.delta > 0);
  assert.match(c.note, /成品率上升/);
  assert.match(formatComparison(c), /metric: 成品率/);
});

test("长度分层：把「任务变重」从聚合差异里剥出来", () => {
  const mk = (iso, len, structure, n) => Array.from({ length: n }, (_, i) => ({
    ts: new Date(Date.parse(iso) + i * 1000).toISOString(),
    verdict: "pass", combined: "pass", structure, len,
  }));
  const records = [
    // A 侧：大量短 prose + 少量长的 deliverable
    ...mk("2026-11-04T00:00:00Z", 300, "prose", 40),
    ...mk("2026-11-04T01:00:00Z", 3000, "deliverable", 10),
    // B 侧：任务更重（短的多是 prose，长的多）
    ...mk("2026-11-06T00:00:00Z", 300, "prose", 10),
    ...mk("2026-11-06T01:00:00Z", 3000, "deliverable", 40),
  ];
  const c = compareWindows(records, { splitAt: split, windowDays: 3, minTurns: 40, now, metric: "deliverable" });
  assert.ok(c.delta > 0, "聚合上看 B 更高");
  const shortBand = c.bands.find((b) => b.band.startsWith("0-"));
  const longBand = c.bands.find((b) => b.band.startsWith("2000-"));
  // 同长度区间里两侧都应"全 prose / 全 deliverable"，说明差异来自分布而非位置
  assert.equal(shortBand.a.hits, 0);
  assert.equal(shortBand.b.hits, 0);
  assert.equal(longBand.a.hits, longBand.a.turns);
  assert.equal(longBand.b.hits, longBand.b.turns);
  assert.match(formatComparison(c), /bands（同长度区间内比较/);
});

test("dedupeRecords：无 digest 时按「同预设+同长度+相邻」近似去重，有 digest 时按 digest", () => {
  const mk = (ts, len, digest) => ({ ts, verdict: "pass", combined: "pass", preset: "p", len, ...(digest ? { digest } : {}) });
  const legacy = [
    mk("2026-11-05T10:00:00Z", 781),
    mk("2026-11-05T10:00:01Z", 781),
    mk("2026-11-05T10:00:02Z", 781),
    mk("2026-11-05T10:00:03Z", 1200),
  ];
  assert.equal(dedupeRecords(legacy, "auto").length, 2, "连续同长应压成一条");
  const modern = [
    mk("2026-11-05T10:00:00Z", 781, "aaaa"),
    mk("2026-11-05T10:00:01Z", 781, "aaaa"),
    mk("2026-11-05T10:00:02Z", 781, "bbbb"),
  ];
  assert.equal(dedupeRecords(modern, "auto").length, 2, "digest 不同就不算重复");
  assert.equal(dedupeRecords(legacy, "none").length, 4, "none 模式不动数据");
});

test("welchT：长度差一倍应显著", () => {
  const a = Array.from({ length: 30 }, (_, i) => 1000 + i);
  const b = Array.from({ length: 30 }, (_, i) => 2000 + i);
  const r = welchT(a, b);
  assert.ok(r.t > 5);
  assert.ok(r.p < 0.001);
});

test("metric=length：按变体比较输出长度", () => {
  const mk = (ts, len, structure = "prose") => ({ ts, verdict: "pass", combined: "pass", preset: "p", len, structure });
  const records = [
    { type: "variant", ts: "2026-11-05T10:00:00Z", preset: "p", lead: false },
    ...Array.from({ length: 10 }, (_, i) => mk(new Date(Date.parse("2026-11-05T10:01:00Z") + i * 1000).toISOString(), 1200 + i)),
    { type: "variant", ts: "2026-11-05T10:10:00Z", preset: "p", lead: true },
    ...Array.from({ length: 10 }, (_, i) => mk(new Date(Date.parse("2026-11-05T10:11:00Z") + i * 1000).toISOString(), 700 + i)),
  ];
  const c = compareWindows(records, { byVariant: true, preset: "p", metric: "length", minTurns: 8 });
  assert.equal(c.metric, "length");
  assert.ok(c.b.mean < c.a.mean);
  assert.match(c.note, /B 更短（显著）|长度差异不显著/);
});

test("since/until：按题分窗，不把别的题算进来", () => {
  const mk = (ts, len) => ({ ts, verdict: "pass", combined: "pass", preset: "p", len, structure: "prose" });
  const records = [
    { type: "variant", ts: "2026-11-05T10:00:00Z", preset: "p", lead: false },
    mk("2026-11-05T10:01:00Z", 1000),
    { type: "variant", ts: "2026-11-05T10:10:00Z", preset: "p", lead: true },
    mk("2026-11-05T10:11:00Z", 2000),
    mk("2026-11-05T10:12:00Z", 2000),
    mk("2026-11-05T11:00:00Z", 9000),
  ];
  const all = compareWindows(records, { byVariant: true, preset: "p", minTurns: 1 });
  const win = compareWindows(records, { byVariant: true, preset: "p", minTurns: 1, until: "2026-11-05T10:30:00Z" });
  assert.equal(all.a.turns + all.b.turns, 4);
  assert.equal(win.a.turns + win.b.turns, 3, "11:00 那条应被窗口排除");
});

test("metric=codeblocks：比较每轮代码块数", () => {
  const mk = (ts, cb) => ({ ts, verdict: "pass", combined: "pass", preset: "p", len: 800, structure: "deliverable", signals: { codeBlocks: cb } });
  const records = [
    { type: "variant", ts: "2026-11-05T10:00:00Z", preset: "p", lead: false },
    mk("2026-11-05T10:01:00Z", 1), mk("2026-11-05T10:02:00Z", 1), mk("2026-11-05T10:03:00Z", 0),
    { type: "variant", ts: "2026-11-05T10:10:00Z", preset: "p", lead: true },
    mk("2026-11-05T10:11:00Z", 4), mk("2026-11-05T10:12:00Z", 3), mk("2026-11-05T10:13:00Z", 2),
  ];
  const c = compareWindows(records, { byVariant: true, preset: "p", metric: "codeblocks", minTurns: 1 });
  assert.equal(c.metric, "codeblocks");
  assert.ok(c.b.mean > c.a.mean);
});
