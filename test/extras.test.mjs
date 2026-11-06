import test from "node:test";
import assert from "node:assert/strict";
import { pickExtras, EXTRA_SECTIONS, REFUSAL_TAXONOMY, PLAIN_SPEECH, ANTI_WAKE } from "../lib/extras.js";

test("默认全关：什么都不注册", () => {
  assert.deepEqual(pickExtras({}), []);
  assert.deepEqual(pickExtras(undefined), []);
});

test("按开关注册，顺序稳定，段名带 compose: 前缀", () => {
  const picked = pickExtras({ antiWake: true, refusalTaxonomy: true });
  assert.deepEqual(picked.map((p) => p.key), ["refusalTaxonomy", "antiWake"]);
  assert.deepEqual(picked.map((p) => p.name), ["compose:refusalTaxonomy", "compose:antiWake"]);
  assert.ok(picked.every((p) => typeof p.order === "number" && typeof p.text === "string"));
});

test("三段文本都不为空，且不含会被 scrub 命中的宿主身份句", () => {
  for (const text of [REFUSAL_TAXONOMY, PLAIN_SPEECH, ANTI_WAKE]) {
    assert.ok(text.length > 80);
    assert.doesNotMatch(text, /You are an AI agent powered by DeepSeek Harness|as an AI language model/i);
  }
});

test("六种形态都在清单里", () => {
  for (const shape of ["开场拒绝", "条件式拒绝", "防御转向", "身份转换", "索证式回避", "元问题诱导"]) {
    assert.ok(REFUSAL_TAXONOMY.includes(shape), `缺形态：${shape}`);
  }
});

test("order 不与 kernel(100)/cwd(900)/boost(1000) 撞车", () => {
  const orders = Object.values(EXTRA_SECTIONS).map((s) => s.order);
  assert.equal(new Set(orders).size, orders.length);
  for (const o of orders) assert.ok(![100, 150, 900, 1000].includes(o));
});
