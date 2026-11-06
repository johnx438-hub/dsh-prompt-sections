// 工具参数：把「作者友好的属性映射」编译成严格 JSON Schema
//
// 背景（0.24.0 之后踩到的真坑）：宿主有两条注册路径——
//   ctx.tools.register(defineTool({...})) 会把属性映射编译成 {type:"object", properties, required}
//   直接 ctx.tools.register({parameters:{...}}) 则**原样**发给模型 API。
// 后者的 parameters 没有 type 时，严格校验的上游会直接 400：
//   Invalid request: tools.function.parameters.type is required and must be "object"

const FLAGS = new Set(["required", "description"]);

/**
 * @param {Record<string, {type:string, required?:boolean, description?:string, items?:object}>} map
 * @returns {{type:"object", properties:object, required?:string[], additionalProperties:false}}
 */
export function toJsonSchema(map = {}) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(map || {})) {
    const source = spec && typeof spec === "object" ? spec : { type: "string" };
    const { required: isRequired, ...rest } = source;
    properties[key] = rest;
    if (isRequired === true) required.push(key);
  }
  const schema = { type: "object", properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return schema;
}

/** 校验一个已注册的 parameters 是否是可被上游接受的 JSON Schema（用于自检/测试） */
export function checkToolParameters(parameters) {
  const issues = [];
  if (!parameters || typeof parameters !== "object") return ["parameters 不是对象"];
  if (parameters.type !== "object") issues.push(`parameters.type 必须是 "object"（当前 ${JSON.stringify(parameters.type)}）`);
  if (!parameters.properties || typeof parameters.properties !== "object") issues.push("parameters.properties 缺失");
  if (Array.isArray(parameters.required)) {
    for (const key of parameters.required) if (!(key in (parameters.properties || {}))) issues.push(`required 里的 ${key} 没有对应 property`);
  }
  for (const [key, spec] of Object.entries(parameters.properties || {})) {
    if (!spec || typeof spec !== "object") { issues.push(`properties.${key} 不是对象`); continue; }
    if (!spec.type) issues.push(`properties.${key}.type 缺失`);
    if (spec.type === "array" && !spec.items) issues.push(`properties.${key} 是 array 但没有 items`);
  }
  return issues;
}

export { FLAGS };
