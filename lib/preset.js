// preset 解析（级联取值；算法移植自 dsh-purge-community lib/identity.js，逻辑同源）
// 关键教训：session.header.agentPreset 常常停在会话创建时的 "standard"，
// 不能拿它盖住用户当前的选择，否则注入会静默失效。

function label(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  if (typeof value.id === "string" && value.id.trim()) return value.id.trim();
  if (typeof value.name === "string" && value.name.trim()) return value.name.trim();
  return "";
}

function sessionOf(context) {
  return context?.agent?.session || context?.session || null;
}

function eventsOf(session) {
  if (!session) return [];
  try {
    if (typeof session.snapshotEvents === "function") {
      const list = session.snapshotEvents();
      if (Array.isArray(list)) return list;
    }
  } catch { /* 忽略 */ }
  return Array.isArray(session.events) ? session.events : [];
}

/** 这一轮实际挂上的预设（用户一切换这里立刻变化） */
function mountedPreset(context) {
  const agent = context?.agent;
  const ctx = agent?.ctx || context?.ctx;
  if (!ctx) return "";
  try {
    const presets = typeof ctx.get === "function" ? ctx.get("agentPresets") : ctx.agentPresets;
    if (!presets || typeof presets.composedPreset !== "function") return "";
    return label(presets.composedPreset(ctx));
  } catch {
    return "";
  }
}

/** 级联：mounted → 最后一个 agent-preset/selected → projectionValues → agentPreset → header */
export function presetFromContext(context) {
  try {
    const session = sessionOf(context);
    const mounted = mountedPreset(context);
    if (mounted) return mounted;

    let selected = "";
    for (const ev of eventsOf(session)) {
      if (!ev || ev.type !== "agent-preset/selected") continue;
      const name = label(ev.data?.agentPreset ?? ev.data?.preset ?? ev.data?.name);
      if (name) selected = name;
    }
    if (selected) return selected;

    return (
      label(session?.projectionValues?.agentPreset) ||
      label(session?.agentPreset) ||
      label(session?.header?.agentPreset)
    );
  } catch {
    return "";
  }
}

/** 子智能体预设 id 形如 unrestricted-child-abc → 归属 unrestricted */
export function matrixKeyFor(presetId, matrix) {
  const id = String(presetId || "").trim();
  if (!id) return "";
  const lower = id.toLowerCase();
  if (Object.hasOwn(matrix, lower)) return lower;
  const keys = Object.keys(matrix).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (k !== "default" && (lower === k || lower.startsWith(`${k}-`) || lower.startsWith(`${k}_`))) return k;
  }
  return "";
}
