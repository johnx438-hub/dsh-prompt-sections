import test from "node:test";
import assert from "node:assert/strict";
import { toJsonSchema, checkToolParameters } from "../lib/tool-schema.js";

test("toJsonSchema：空映射也产出合法 object schema", () => {
  const s = toJsonSchema();
  assert.deepEqual(s, { type: "object", properties: {}, additionalProperties: false });
  assert.deepEqual(checkToolParameters(s), []);
});

test("toJsonSchema：required 抽出成数组，不进 property", () => {
  const s = toJsonSchema({
    lead: { type: "boolean", required: true, description: "前置" },
    preset: { type: "string", description: "预设" },
  });
  assert.equal(s.type, "object");
  assert.deepEqual(s.required, ["lead"]);
  assert.equal(s.properties.lead.required, undefined, "required 不应留在 property 里");
  assert.equal(s.properties.lead.description, "前置");
  assert.deepEqual(checkToolParameters(s), []);
});

test("checkToolParameters：抓出真实 400 的成因（缺 type）", () => {
  const issues = checkToolParameters({ properties: {} });
  assert.ok(issues.some((i) => i.includes("parameters.type")));
});

test("checkToolParameters：array 缺 items、required 指向不存在的键都会被报出来", () => {
  const issues = checkToolParameters({
    type: "object",
    properties: { bots: { type: "array" } },
    required: ["bots", "ghost"],
  });
  assert.ok(issues.some((i) => i.includes("items")));
  assert.ok(issues.some((i) => i.includes("ghost")));
});
