// 预设注册：DSH 0.1.7+ 的模式下拉只认运行时 `agentPresets.register()`，
// 把目录丢进 ~/.dsh/.agent-presets/ 并不会出现在下拉里（社区版源码里明确记着这个坑）。
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseCordisYaml } from "./yaml-mini.js";
import { migratePresetDefinition, stripLegacyToolFilter } from "./preset-compat.js";

const META_KEYS = new Set(["name", "description", "order"]);

/** 读一个预设目录 → agentPresets.register 的定义对象 */
export function readPresetDefinition(id, dir) {
  const read = (name) => {
    try {
      return readFileSync(path.join(dir, name), "utf8");
    } catch (e) {
      throw new Error(`${name} 不可读: ${e && e.message}`);
    }
  };
  const scope = { process, dshHomePath: (rel) => path.join(os.homedir(), ".dsh", rel) };
  const meta = parseCordisYaml(read("preset.yml"), scope)[0] || {};
  const plugins = parseCordisYaml(read("agent.cordis.yml"), scope);
  if (!Array.isArray(plugins) || !plugins.length) throw new Error("agent.cordis.yml 解析为空");
  const definition = { id };
  for (const [k, v] of Object.entries(meta)) if (META_KEYS.has(k)) definition[k] = v;
  definition.plugins = plugins;
  return definition;
}

/**
 * 等注册表就绪后软注册一次；返回落定的清单供报告使用。
 * 失败只记录，不抛（预设注册失败不该影响宿主启动）。
 */
export async function registerPresets(registryOrResolver, specs, opts = {}) {
  const resolve = typeof registryOrResolver === "function" ? registryOrResolver : () => registryOrResolver;
  const { retries = 40, delayMs = 400, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts;
  const done = [];
  let reg = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const candidate = resolve();
      if (candidate && typeof candidate.register === "function") { reg = candidate; break; }
    } catch { /* 服务未 inject 时读属性会抛，继续等 */ }
    await sleep(delayMs);
  }
  if (!reg || typeof reg.register !== "function") {
    done.push({ error: "agentPresets 注册表未就绪" });
    return done;
  }
  for (const spec of specs) {
    try {
      const def = readPresetDefinition(spec.id, spec.dir || path.join(os.homedir(), ".dsh", ".agent-presets", spec.id));
      let definitions;
      let migration = "none";
      let note = "";
      try {
        const migrated = migratePresetDefinition(def);
        definitions = migrated.definitions;
        migration = migrated.policies.length ? "child-preset" : "none";
      } catch (e) {
        // 迁移失败不挡住加载：退化为"剥掉 legacy toolFilter"（子智能体不再受限）
        const stripped = stripLegacyToolFilter(def);
        definitions = [stripped.definition];
        migration = "stripped";
        note = String((e && e.message) || e);
      }
      const registeredIds = [];
      const releases = [];
      for (const d of definitions) {
        const release = await reg.register(d);
        releases.push(typeof release === "function" ? release : null);
        registeredIds.push({ id: d.id, order: d.order, entries: d.plugins.length });
      }
      done.push({
        id: def.id,
        entries: definitions.at(-1).plugins.length,
        migration,
        note,
        registered: registeredIds,
        release: () => { for (const r of releases) try { if (typeof r === "function") r(); } catch { /* 忽略 */ } },
      });
    } catch (e) {
      done.push({ id: spec.id, error: String((e && e.message) || e) });
    }
  }
  return done;
}
