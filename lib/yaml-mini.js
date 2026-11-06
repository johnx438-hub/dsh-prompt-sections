// cordis YAML 子集解析器
// 目的：把 agent.cordis.yml 读成 agentPresets.register({ plugins }) 需要的行数组。
// 只支持该文件实际用到的语法：缩进映射 / 列表 / `|` 块标量 / `!!js <expr>` / 行尾注释。
// 不追求通用 YAML 兼容；解析失败必须抛清晰错误，绝不静默返回半个结构。

const indentOf = (line) => line.match(/^ */)[0].length;
const isBlank = (line) => line.trim() === "";
const isComment = (line) => line.trim().startsWith("#");

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).replace(/\s+$/, "");
    }
  }
  return line.replace(/\s+$/, "");
}

function unquote(raw) {
  const t = raw.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1).replace(/\\"/g, '"');
  }
  return t;
}

function evalJs(expr, scope) {
  try {
    return Function(...Object.keys(scope), '"use strict"; return (' + expr + ');')(...Object.values(scope));
  } catch (e) {
    throw new Error('!!js 表达式求值失败: ' + expr + ' (' + (e && e.message) + ')');
  }
}

function scalar(raw, scope) {
  const t = raw.trim();
  if (t.startsWith('!!js ')) return evalJs(t.slice(5), scope);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  return unquote(t);
}

function blockScalar(lines, i, keyIndent) {
  const body = [];
  let j = i;
  let bodyIndent = null;
  while (j < lines.length) {
    const line = lines[j];
    if (isBlank(line)) { body.push(''); j++; continue; }
    const ind = indentOf(line);
    if (ind <= keyIndent) break;
    if (bodyIndent === null) bodyIndent = ind;
    body.push(line.slice(Math.min(bodyIndent, ind)));
    j++;
  }
  while (body.length && body.at(-1).trim() === '') body.pop();
  return [body.join('\n') + '\n', j];
}

function parseMap(lines, start, indent, scope) {
  const out = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line) || isComment(line)) { i++; continue; }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) throw new Error('缩进异常（第 ' + (i + 1) + ' 行）: ' + line.trim().slice(0, 40));
    if (line.trim().startsWith('- ')) break;
    const m = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (!m) throw new Error('无法解析的键行（第 ' + (i + 1) + ' 行）: ' + line.trim().slice(0, 40));
    const key = m[1].trim();
    const raw = m[2];
    if (raw === '' || raw.startsWith('|') || raw === '>') {
      if (raw === '>' ) { const [t, n] = blockScalar(lines, i + 1, indent); out[key] = t; i = n; continue; }
      if (raw.startsWith('|')) {
        const [text, next] = blockScalar(lines, i + 1, indent);
        out[key] = text;
        i = next;
        continue;
      }
      let j = i + 1;
      while (j < lines.length && (isBlank(lines[j]) || isComment(lines[j]))) j++;
      if (j < lines.length && indentOf(lines[j]) > indent) {
        const [val, next] = parseBlock(lines, j, indentOf(lines[j]), scope);
        out[key] = val;
        i = next;
        continue;
      }
      out[key] = null;
      i++;
      continue;
    }
    out[key] = scalar(raw, scope);
    i++;
  }
  return [out, i];
}

function parseList(lines, start, indent, scope) {
  const out = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line) || isComment(line)) { i++; continue; }
    const ind = indentOf(line);
    if (ind !== indent || !line.trim().startsWith('- ')) break;
    const rest = line.trim().slice(2);
    const inlineKey = rest.match(/^([^:]+):\s*(.*)$/);
    if (inlineKey && !rest.startsWith('!!js')) {
      const patched = lines.slice();
      patched[i] = ' '.repeat(indent + 2) + rest;
      const [val, next] = parseMap(patched, i, indent + 2, scope);
      out.push(val);
      i = next;
      continue;
    }
    out.push(scalar(rest, scope));
    i++;
  }
  return [out, i];
}

function parseBlock(lines, start, indent, scope) {
  return lines[start].trim().startsWith('- ')
    ? parseList(lines, start, indent, scope)
    : parseMap(lines, start, indent, scope);
}

export function parseCordisYaml(text, scope) {
  const env = scope || { process };
  const lines = String(text == null ? '' : text)
    .replace(/\r\n/g, '\n')
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map(stripComment);
  let i = 0;
  while (i < lines.length && (isBlank(lines[i]) || isComment(lines[i]))) i++;
  if (i >= lines.length) return [];
  const [value, next] = parseBlock(lines, i, indentOf(lines[i]), env);
  const rest = lines.slice(next).filter((l) => !isBlank(l) && !isComment(l));
  if (rest.length) throw new Error('解析后仍有未消费内容（' + rest.length + ' 行）: ' + rest[0].trim().slice(0, 40));
  return Array.isArray(value) ? value : [value];
}
