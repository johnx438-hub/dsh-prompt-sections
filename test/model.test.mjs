import test from "node:test";
import assert from "node:assert/strict";
import { modelOf, contextShape } from "../lib/model.js";

test("modelOf：agent.model 优先", () => {
  assert.deepEqual(modelOf({ agent: { model: "deepseek-flash" } }), { model: "deepseek-flash", path: "agent.model" });
});

test("modelOf：退到 session.header.config.model", () => {
  const ctx = { agent: { session: { header: { config: { model: "claude-sonnet" } } } } };
  assert.equal(modelOf(ctx).model, "claude-sonnet");
});

test("modelOf：route 形态也能取到", () => {
  assert.equal(modelOf({ agent: { route: { model: "gpt-6-sol" } } }).model, "gpt-6-sol");
  assert.equal(modelOf({ session: { header: { config: { model: "glm-5" } } } }).model, "glm-5");
});

test("modelOf：拿不到就返回 null，不猜", () => {
  assert.deepEqual(modelOf({}), { model: null, path: null });
  assert.deepEqual(modelOf(null), { model: null, path: null });
  assert.deepEqual(modelOf({ agent: { model: "   " } }), { model: null, path: null });
});

test("modelOf：getter 抛错不影响其它候选", () => {
  const ctx = { agent: { get model() { throw new Error("boom") }, route: { model: "ok-model" } } };
  assert.equal(modelOf(ctx).model, "ok-model");
});

test("contextShape：只给键名，不给值", () => {
  const shape = contextShape({ agent: { model: "secret-model", session: { header: { config: { model: "x" } } } } });
  assert.ok(shape.context.includes("agent"));
  assert.ok(shape.agent.includes("model"));
  assert.ok(Array.isArray(shape.sessionHeaderConfig));
  assert.equal(JSON.stringify(shape).includes("secret-model"), false, "不应泄露值");
});
