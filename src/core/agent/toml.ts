/**
 * 手术式 TOML 编辑：只改我们管的键和段，用户的其它内容（注释、其它 provider、
 * 未知字段）原样保留。移植自 tokenplan-quick-setup 的 _toml_* 系列（已经过 Codex /
 * Kimi 真实加载验证）。
 *
 * 为什么不引入 TOML 库整体解析再序列化：那会丢掉用户的注释与排版，且各 Agent
 * 自己的 TOML 方言不一，round-trip 有风险。我们写的内容很窄（根键 + 若干段的
 * 字符串/数字/布尔），按行处理足够，也零依赖。
 */

/** TOML 值：只支持我们会写的三种 */
export type TomlValue = string | number | boolean;

/**
 * 转义成 TOML basic string（"..."）的内容。
 * 规则与 JSON 一致：反斜杠、双引号与常见控制字符。Key 里一旦混进意外字符，
 * 不转义会直接破坏整个配置文件（Codex/Kimi 启动即报错）。
 */
export function escapeBasicString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function render(key: string, value: TomlValue): string {
  if (typeof value === "boolean") return `${key} = ${value ? "true" : "false"}`;
  if (typeof value === "number") return `${key} = ${value}`;
  return `${key} = "${escapeBasicString(value)}"`;
}

function isHeader(line: string): boolean {
  const s = line.trim();
  return s.startsWith("[") && s.endsWith("]");
}

/** 该行是否在给 key 赋值（key = / key=） */
function assigns(line: string, key: string): boolean {
  const s = line.trim();
  return s.startsWith(`${key} `) || s.startsWith(`${key}=`);
}

/**
 * 表头归一：[models."glm-5.3"] 与 [models.glm-5.3] 都归成 models.glm-5.3。
 * 用于识别旧版写下的未加引号段（含点号的模型 ID 会被 TOML 解析成嵌套表）。
 */
export function normalizeHeader(header: string): string {
  const inner = header.trim().slice(1, -1);
  return inner
    .split(".")
    .map((p) => p.trim().replace(/^["']|["']$/g, ""))
    .join(".");
}

/** 设置根级键（第一个表头之前），已存在则替换，否则插在第一个表头前 */
export function upsertRootKey(lines: string[], key: string, value: TomlValue): string[] {
  const out = [...lines];
  let rootEnd = out.findIndex(isHeader);
  if (rootEnd < 0) rootEnd = out.length;
  for (let i = 0; i < rootEnd; i++) {
    if (assigns(out[i]!, key)) {
      out[i] = render(key, value);
      return out;
    }
  }
  // 插在根区最后一个非空行之后，而不是紧贴表头——保留根区与第一个表头之间的空行
  let at = rootEnd;
  while (at > 0 && out[at - 1]!.trim() === "") at--;
  // 根区原本为空、紧接着就是表头时补一个空行，免得根键贴着表头
  const gap = at === 0 && rootEnd < out.length ? [""] : [];
  out.splice(at, 0, render(key, value), ...gap);
  return out;
}

/** 删除归一化表头在 targets 里的整段（[[数组表]] 不动） */
export function removeSections(lines: string[], targets: Set<string>): string[] {
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const s = line.trim();
    if (isHeader(s) && !s.startsWith("[[")) {
      skipping = targets.has(normalizeHeader(s));
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }
  return out;
}

/**
 * 创建或更新一段 [table]：我们给的键逐个替换/追加，段里其它行原样保留。
 * header 传完整表头文本，如 `[model_providers.tokenhub]`、`[models."glm-5.3"]`。
 */
export function upsertSection(lines: string[], header: string, entries: Record<string, TomlValue>): string[] {
  const start = lines.findIndex((l) => l.trim() === header);
  const rendered = Object.entries(entries).map(([k, v]) => render(k, v));
  if (start < 0) {
    // 新段前只留一个空行：去掉原文件尾部的空行再补
    const trimmed = [...lines];
    while (trimmed.length && trimmed[trimmed.length - 1]!.trim() === "") trimmed.pop();
    return [...trimmed, ...(trimmed.length ? [""] : []), header, ...rendered];
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeader(lines[i]!)) {
      end = i;
      break;
    }
  }
  const handled = new Set<string>();
  const kept: string[] = [];
  for (const line of lines.slice(start + 1, end)) {
    const key = Object.keys(entries).find((k) => assigns(line, k));
    if (key === undefined) {
      kept.push(line);
    } else if (!handled.has(key)) {
      kept.push(render(key, entries[key]!));
      handled.add(key);
    }
    // 同一键重复出现的后续行丢弃，避免 TOML 报重复键
  }
  // 新键接在段内最后一个非空行之后，段尾的空行留在最后，免得新键和表头之间隔出空行
  let tail = kept.length;
  while (tail > 0 && kept[tail - 1]!.trim() === "") tail--;
  const added = Object.entries(entries)
    .filter(([k]) => !handled.has(k))
    .map(([k, v]) => render(k, v));
  return [...lines.slice(0, start + 1), ...kept.slice(0, tail), ...added, ...kept.slice(tail), ...lines.slice(end)];
}

/** 删掉根级（第一个表头之前）给 key 赋值的行 */
export function dropRootKey(lines: string[], key: string): string[] {
  let rootEnd = lines.findIndex(isHeader);
  if (rootEnd < 0) rootEnd = lines.length;
  return [...lines.slice(0, rootEnd).filter((l) => !assigns(l, key)), ...lines.slice(rootEnd)];
}

/** 删掉某段 [table] 里给 key 赋值的行（段不存在则原样返回） */
export function dropSectionKey(lines: string[], header: string, key: string): string[] {
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) return lines;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeader(lines[i]!)) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start + 1), ...lines.slice(start + 1, end).filter((l) => !assigns(l, key)), ...lines.slice(end)];
}

/** 折叠连续空行，删段之后避免留下大片空白 */
export function collapseBlankLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === "" && out.length && out[out.length - 1]!.trim() === "") continue;
    out.push(line);
  }
  return out;
}

/** 行数组 → 文件内容（去尾部空白，补一个换行） */
export function joinLines(lines: string[]): string {
  return `${lines.join("\n").replace(/\s+$/, "")}\n`;
}

/** 文件内容 → 行数组（兼容 CRLF） */
export function splitLines(text: string): string[] {
  return text.length ? text.replace(/\r\n/g, "\n").split("\n") : [];
}

/**
 * 取根级键的字符串值（只认 key = "..." 形态），给 status 展示当前指向用。
 * 解析不了返回 undefined，不抛错。
 */
export function readRootString(text: string, key: string): string | undefined {
  for (const line of splitLines(text)) {
    if (isHeader(line)) break;
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(line);
    if (m) return m[1];
  }
  return undefined;
}
