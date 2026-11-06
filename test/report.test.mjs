import test from "node:test";
import assert from "node:assert/strict";
import { summarizeRecords, formatReport } from "../lib/report.js";

const now = Date.parse("2026-11-05T12:00:00Z");
const rec = (over = {}) => ({ ts: new Date(now).toISOString(), verdict: "pass", combined: "pass", ...over });

const records = [
  rec(),
  rec({ verdict: "refusal", combined: "refusal", conflict: true }),
  rec({ verdict: "pass", combined: "pass" }),
  rec({ type: "assembly", injected: true, scrub: [{ id: "untrusted:read-only-snapshot", count: 2 }], shadow: [{ id: "identity:ai-agent", count: 3 }] }),
  rec({ type: "hello" }),
  rec({ type: "alarm", ts: new Date(now - 1000).toISOString() }),
  rec({ ts: new Date(now - 2 * 86400000).toISOString(), verdict: "fallback", combined: "fallback" }),
  { ts: "not-a-date", verdict: "pass" },
];

test("汇总：轮次、两套口径、冲突、装配、告警分开计", () => {
  const s = summarizeRecords(records, { now, days: 7 });
  assert.equal(s.turns, 5);
  assert.equal(s.combined.pass, 3);
  assert.equal(s.combined.refusal, 1);
  assert.equal(s.combined.fallback, 1);
  assert.equal(s.conflicts, 1);
  assert.equal(s.assemblies, 1);
  assert.equal(s.injected, 1);
  assert.equal(s.hellos, 1);
  assert.equal(s.alarms, 1);
  assert.ok(s.lastAlarm);
  assert.equal(s.scrub["untrusted:read-only-snapshot"], 2);
  assert.equal(s.shadow["identity:ai-agent"], 3);
});

test("汇总：按天分桶只含窗口内的记录", () => {
  const s = summarizeRecords(records, { now, days: 1 });
  const days = s.days.map((d) => d.day);
  assert.ok(days.includes("2026-11-05"));
  assert.ok(!days.includes("2026-11-03"), "窗口外的天不该出现");
});

test("汇总：空输入不炸", () => {
  const s = summarizeRecords([], { now });
  assert.equal(s.turns, 0);
  assert.deepEqual(s.days, []);
  assert.match(formatReport(s), /turns: 0/);
});

test("格式化：带上宿主与 scrubMode，没有命中写 -", () => {
  const text = formatReport(summarizeRecords(records, { now }), { host: "0.2.1-rc.2", scrubMode: "shadow" });
  assert.match(text, /host: 0\.2\.1-rc\.2/);
  assert.match(text, /scrubMode: shadow/);
  assert.match(text, /shadow: identity:ai-agent×3/);
  assert.match(text, /days:/);
});

test("汇总：按 preset 分组", () => {
  const recs = [
    { ts: new Date(now).toISOString(), verdict: "pass", combined: "pass", preset: "cold-deep-scout" },
    { ts: new Date(now).toISOString(), verdict: "refusal", combined: "refusal", preset: "cold-deep-scout" },
    { ts: new Date(now).toISOString(), verdict: "pass", combined: "pass", preset: "unrestricted" },
  ];
  const s = summarizeRecords(recs, { now });
  assert.equal(s.presets["cold-deep-scout"].turns, 2);
  assert.equal(s.presets["cold-deep-scout"].refusal, 1);
  assert.equal(s.presets.unrestricted.turns, 1);
  assert.match(formatReport(s), /presets:/);
});
