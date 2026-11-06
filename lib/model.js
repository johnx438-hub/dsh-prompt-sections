// 从 context 里抠出"这轮用的是哪个模型"
//
// 宿主的 context 形状在不同版本里不一样：有的挂在 agent 上，有的在 session.header.config，
// 有的只在 route 里。这里按优先级逐个试，拿不到就返回 null（不猜、不伪造）。
// 拿不到时由调用方落一条 ctx-probe（只记键名，不记值），用来定位真实位置。

const CANDIDATES = [
  ["agent.model", (c) => c?.agent?.model],
  ["agent.modelId", (c) => c?.agent?.modelId],
  ["agent.route.model", (c) => c?.agent?.route?.model],
  ["agent.route.modelId", (c) => c?.agent?.route?.modelId],
  ["agent.config.model", (c) => c?.agent?.config?.model],
  ["agent.session.model", (c) => c?.agent?.session?.model],
  ["agent.session.route.model", (c) => c?.agent?.session?.route?.model],
  ["agent.session.header.model", (c) => c?.agent?.session?.header?.model],
  ["agent.session.header.config.model", (c) => c?.agent?.session?.header?.config?.model],
  ["agent.session.projectionValues.model", (c) => c?.agent?.session?.projectionValues?.model],
  ["session.model", (c) => c?.session?.model],
  ["session.header.config.model", (c) => c?.session?.header?.config?.model],
];

/** 返回 { model, path }；找不到时 { model: null, path: null } */
export function modelOf(context) {
  for (const [path, read] of CANDIDATES) {
    try {
      const value = read(context);
      if (typeof value === "string" && value.trim()) return { model: value.trim(), path };
    } catch { /* 某些层级是 getter，读会抛 */ }
  }
  return { model: null, path: null };
}

/** 一次性诊断：只返回键名，不返回值（避免把密钥/路径写进账本） */
export function contextShape(context) {
  const keys = (obj) => {
    if (!obj || (typeof obj !== "object" && typeof obj !== "function")) return null;
    try { return Object.keys(obj).slice(0, 40); } catch { return null; }
  };
  return {
    context: keys(context),
    agent: keys(context?.agent),
    agentRoute: keys(context?.agent?.route),
    agentConfig: keys(context?.agent?.config),
    session: keys(context?.agent?.session ?? context?.session),
    sessionHeader: keys((context?.agent?.session ?? context?.session)?.header),
    sessionHeaderConfig: keys((context?.agent?.session ?? context?.session)?.header?.config),
  };
}
