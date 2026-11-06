// 装配校验：证明"我们的段真的进了发给模型的那份 prompt"
//
// 0.7.1 的 last-load.json 只能证明 apply() 跑过、section 注册过，
// 证明不了宿主每次组装时还留着它。这里在 system-prompt/assemble 钩子里
// 直接看组装结果：段在不在、排在第几、多少字、canary 串是否出现。
//
// 纯函数，不抛错（调用方在事件总线里，抛错会炸会话）。

import { createHash } from "node:crypto";

/** 从组装对象里读出我们这一段的位置与规模 */
const shortHash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);

export function verifyAssembly(assembled, { sectionName, preset = null, token = null } = {}) {
  const sections = Array.isArray(assembled && assembled.sections) ? assembled.sections : [];
  let index = -1;
  let kernelChars = 0;
  const chars = [];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const text = section && typeof section.text === "string" ? section.text : "";
    chars.push(text.length);
    if (section && section.name === sectionName) {
      index = i;
      kernelChars = text.length;
    }
  }
  const totalChars = chars.reduce((n, v) => n + v, 0);
  const tokenFound = token
    ? sections.some((s) => s && typeof s.text === "string" && s.text.includes(token))
    : null;
  const kernelText = index >= 0 ? String(sections[index].text ?? "") : "";
  return {
    preset,
    sections: sections.length,
    kernelIndex: index,
    kernelChars,
    kernelHash: kernelText ? shortHash(kernelText) : null,
    totalChars,
    atHead: index === 0,
    atTail: index >= 0 && index === sections.length - 1,
    injected: index >= 0 && kernelChars > 0,
    tokenFound,
    sectionChars: chars,
  };
}

/** 两张校验记录是否"同一形态"（用于去重，避免每步都写一行） */
export function sameVerification(a, b) {
  if (!a || !b) return false;
  return a.sections === b.sections
    && a.kernelIndex === b.kernelIndex
    && a.kernelChars === b.kernelChars
    && a.kernelHash === b.kernelHash
    && a.totalChars === b.totalChars
    && a.tokenFound === b.tokenFound
    && a.preset === b.preset;
}
