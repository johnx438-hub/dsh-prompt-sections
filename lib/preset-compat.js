// 预设兼容迁移（移植自 dsh-purge-community lib/preset-compat.js 的 migratePresetDefinition）
//
// 背景：宿主 0.2.x 起 tool-subagent 不再接受 legacy toolFilter（会让整条预设注册失败）。
// 迁移做法：把 toolFilter 转成原生子预设 ——
//   子预设 = 父预设的副本，剔除被 deny 的工具行，order = 父 order + 0.1
//   父预设的 tool-subagent 改为 agentPreset: <子预设 id>（spawn only）
import { createHash } from "node:crypto";

const SUBAGENT = "@deepseek-ai/dsh-tool-subagent";

// 包名 → 工具名（toolFilter 里用的是工具名）。community 只映射了 workflow/ralph；
// 这里补上 subagent_fork，否则含 fork 的策略会被判"未知工具"而无法迁移。
const TOOL_NAMES = new Map([
  ["@deepseek-ai/dsh-tool-workflow", "workflow"],
  ["@deepseek-ai/dsh-tool-ralph", "ralph"],
  ["@deepseek-ai/dsh-tool-subagent-fork", "subagent_fork"],
]);

const hash = (text) => createHash("sha256").update(text).digest("hex");

/** 遍历行树：组条目的 config 是子行数组 */
function visit(rows, fn, at = []) {
  rows.forEach((row, index) => {
    const here = [...at, index];
    fn(row, here);
    if (row && row.group === true && Array.isArray(row.config)) visit(row.config, fn, here);
  });
}

function rowAt(rows, at) {
  let node = rows;
  let row;
  for (const index of at) {
    row = node[index];
    node = row && Array.isArray(row.config) ? row.config : [];
  }
  return row;
}

function toolName(row) {
  if (!row || row.group || typeof row.name !== "string") return "";
  if (row.name === SUBAGENT) return row.config?.toolName ?? "subagent";
  return TOOL_NAMES.get(row.name) ?? "";
}

/**
 * 把 legacy toolFilter 迁成原生子预设。
 * @returns {{definitions: object[], policies: object[]}} 子预设在前、父预设在后的注册序
 * @throws 配置有歧义/不支持时抛错（调用方决定是否降级为"剥掉 toolFilter"）
 */
export function migratePresetDefinition(definition) {
  const parent = structuredClone(definition);
  const policies = [];
  const names = new Set();
  visit(parent.plugins, (item) => {
    const name = toolName(item);
    if (name) names.add(name);
  });

  visit(parent.plugins, (row, at) => {
    if (row.name !== SUBAGENT || !Object.hasOwn(row.config ?? {}, "toolFilter")) return;
    const config = row.config;
    const filter = config.toolFilter;
    if (config.provider !== "spawn" || config.agentPreset !== undefined || config.allowedAgentPresets !== undefined) {
      throw new Error(`${definition.id}/${row.id}: legacy toolFilter 需要明确的 spawn provider，原配置保留`);
    }
    if (!filter || Object.keys(filter).some((k) => k !== "deny") || !Array.isArray(filter.deny)
      || filter.deny.some((v) => typeof v !== "string" || !v) || new Set(filter.deny).size !== filter.deny.length) {
      throw new Error(`${definition.id}/${row.id}: 不支持的 legacy toolFilter，原配置保留`);
    }
    const unknown = filter.deny.filter((name) => !names.has(name));
    if (unknown.length) {
      throw new Error(`${definition.id}/${row.id}: 无法保留 toolFilter（未知工具 ${unknown.join(", ")}），原配置保留`);
    }
    policies.push({
      at,
      childId: `${definition.id}-child-${hash(JSON.stringify({ at, deny: filter.deny })).slice(0, 10)}`,
      deny: [...filter.deny],
      rowId: row.id ?? at.join("."),
    });
  });

  if (policies.length > 1) throw new Error(`${definition.id}: 多处 legacy 子策略需要显式迁移，原配置保留`);
  if (!policies.length) return { definitions: [parent], policies };

  const policy = policies[0];
  const child = structuredClone(parent);
  child.id = policy.childId;
  child.name = `${definition.name ?? definition.id} · 子任务`;
  child.description = `兼容子预设：继承父预设提示词和设置，排除 ${policy.deny.join("、")}。主会话请选择 ${definition.name ?? definition.id}。`;
  child.order = (definition.order ?? 20) + 0.1;
  delete rowAt(child.plugins, policy.at).config.toolFilter;

  const filterRows = (rows) =>
    rows
      .filter((row) => !policy.deny.includes(toolName(row)))
      .map((row) => {
        if (row.group === true && Array.isArray(row.config)) row.config = filterRows(row.config);
        return row;
      });
  child.plugins = filterRows(child.plugins);

  const config = rowAt(parent.plugins, policy.at).config;
  delete config.toolFilter;
  config.agentPreset = child.id;
  return { definitions: [child, parent], policies };
}

/** 降级方案：只剥掉 toolFilter（子智能体不再受限，但预设能加载） */
export function stripLegacyToolFilter(definition) {
  const parent = structuredClone(definition);
  const dropped = [];
  visit(parent.plugins, (row, at) => {
    if (row.name === SUBAGENT && row.config && Object.hasOwn(row.config, "toolFilter")) {
      delete row.config.toolFilter;
      dropped.push(`${at.join(".")}:${row.id ?? "?"}`);
    }
  });
  return { definition: parent, dropped };
}
