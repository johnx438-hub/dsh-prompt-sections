import test from "node:test";
import assert from "node:assert/strict";
import { variantTimeline, variantAt, splitByVariant } from "../lib/variant.js";
import { compareWindows } from "../lib/ab.js";

const rec = (ts, over = {}) => ({ ts, verdict: "pass", combined: "pass", preset: "p", structure: "prose", len: 400, ...over });
const variant = (ts, lead) => ({ type: "variant", ts, preset: "p", lead });

test("时间线：按时间升序，非 variant 记录忽略", () => {
  const t = variantTimeline([rec("2026-11-05T10:00:00Z"), variant("2026-11-05T10:01:00Z", true), variant("2026-11-05T10:00:00Z", false)]);
  assert.equal(t.length, 2);
  assert.equal(t[0].value, "false");
});

test("variantAt：时间线之前为空，之后取最近一次", () => {
  const tl = variantTimeline([variant("2026-11-05T10:00:00Z", false), variant("2026-11-05T11:00:00Z", true)]);
  assert.equal(variantAt(tl, Date.parse("2026-11-05T09:00:00Z")), null);
  assert.equal(variantAt(tl, Date.parse("2026-11-05T10:30:00Z")), "false");
  assert.equal(variantAt(tl, Date.parse("2026-11-05T11:30:00Z")), "true");
});

test("splitByVariant：ABBA 交替时按当时生效值归属", () => {
  const records = [
    variant("2026-11-05T10:00:00Z", false),
    rec("2026-11-05T10:10:00Z", { structure: "prose" }),
    variant("2026-11-05T10:20:00Z", true),
    rec("2026-11-05T10:30:00Z", { structure: "deliverable" }),
    variant("2026-11-05T10:40:00Z", false),
    rec("2026-11-05T10:50:00Z", { structure: "deliverable" }),
  ];
  const { a, b } = splitByVariant(records, { preset: "p" });
  assert.equal(a.length, 2, "A 侧应有两次（10:10 与 10:50）");
  assert.equal(b.length, 1, "B 侧一次");
});

test("compareWindows(byVariant)：不需要 split 也能分桶比较", () => {
  const records = [
    variant("2026-11-05T10:00:00Z", false),
    rec("2026-11-05T10:10:00Z", { structure: "prose" }),
    rec("2026-11-05T10:11:00Z", { structure: "prose" }),
    variant("2026-11-05T10:20:00Z", true),
    rec("2026-11-05T10:30:00Z", { structure: "deliverable" }),
    rec("2026-11-05T10:31:00Z", { structure: "deliverable" }),
  ];
  const c = compareWindows(records, { byVariant: true, preset: "p", metric: "deliverable", minTurns: 2 });
  assert.equal(c.mode, "byVariant");
  assert.deepEqual(c.values, ["false", "true"]);
  assert.equal(c.a.deliverable, 0);
  assert.equal(c.b.deliverable, 2);
  assert.ok(c.delta > 0);
});

test("compareWindows(byVariant)：只有一个变体时明说没数据", () => {
  const records = [variant("2026-11-05T10:00:00Z", false), rec("2026-11-05T10:10:00Z")];
  const c = compareWindows(records, { byVariant: true, preset: "p" });
  assert.match(c.note, /还没有两个变体/);
});
