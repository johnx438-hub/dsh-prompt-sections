import test from "node:test";
import assert from "node:assert/strict";
import { pickExtras, EXTRA_SECTIONS, WORLD_FRAME } from "../lib/extras.js";

test("worldFrame 默认关", () => {
  assert.equal(pickExtras({}).some((p) => p.key === "worldFrame"), false);
});

test("worldFrame 开启后 order=90（在载荷 100 之前，作为前提）", () => {
  const picked = pickExtras({ worldFrame: true });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].name, "compose:worldFrame");
  assert.equal(picked[0].order, 90);
  assert.ok(picked[0].order < 100, "必须排在载荷之前");
});

test("worldFrame 明确否掉「改写成学习项目」这条逃避路径", () => {
  assert.match(WORLD_FRAME, /学习项目/);
  assert.match(WORLD_FRAME, /改写任务/);
  assert.match(WORLD_FRAME, /占位符/);
});

test("worldFrame 不含会被强模型当作「框架包装」识破的口号词", () => {
  for (const banned of ["红队", "授权渗透", "合规研究", "安全研究", "仅供学习", "教育目的"]) {
    assert.equal(WORLD_FRAME.includes(banned), false, `不该出现「${banned}」`);
  }
});
