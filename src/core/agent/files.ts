/**
 * agent 接入的文件层：写前备份、台账、JSON 深合并、失败回滚。
 *
 * 可逆性是硬约束：每个被改动的文件都记进台账（原本是否存在、备份在哪），
 * `agent restore` 据此还原——原本存在的拷回备份，原本不存在的删掉。
 *
 * HOME 与 thcli 配置目录都可注入（AgentEnv），测试用临时目录，绝不碰真实配置。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 运行环境：HOME、thcli 配置目录、平台。测试时整体替换 */
export interface AgentEnv {
  home: string;
  /** ~/.thcli */
  configDir: string;
  platform: NodeJS.Platform;
  /** 时间戳来源（备份目录名），测试固定 */
  now: () => Date;
}

/** 默认环境：真实 HOME */
export function defaultAgentEnv(): AgentEnv {
  const home = os.homedir();
  return { home, configDir: path.join(home, ".thcli"), platform: process.platform, now: () => new Date() };
}

/** 台账里一个被写过的文件 */
export interface FileRecord {
  path: string;
  /** 写入前文件是否已存在：决定还原是"拷回备份"还是"删除" */
  existed: boolean;
  /** 备份文件路径（existed 为 true 时才有） */
  backup?: string;
}

/** 一个工具的接入记录 */
export interface ToolRecord {
  tool: string;
  plan: string;
  site: string;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  configuredAt: string;
  files: FileRecord[];
  /** 主配置文件的实际路径（尊重 CODEX_HOME 等覆盖），status 读它判断是否仍指向 TokenHub */
  mainFile?: string;
}

/** 台账 */
export interface AgentState {
  version: 1;
  tools: Record<string, ToolRecord>;
}

function statePath(env: AgentEnv): string {
  return path.join(env.configDir, "agent-state.json");
}

/** 读台账；不存在或损坏返回空台账（损坏时不覆盖原文件，交给 save 时整体重写） */
export function loadState(env: AgentEnv): AgentState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(env), "utf8")) as AgentState;
    if (parsed && typeof parsed === "object" && parsed.tools) return parsed;
  } catch {
    // 落到空台账
  }
  return { version: 1, tools: {} };
}

/** 写台账，0600（里面有文件路径，没有密钥，但与密钥文件同级管理） */
export function saveState(env: AgentEnv, state: AgentState): void {
  writeSecure(statePath(env), `${JSON.stringify(state, null, 2)}\n`);
}

/** 写文件并收紧权限到 0600（已存在的文件 writeFileSync 的 mode 不生效，显式 chmod） */
export function writeSecure(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 某些文件系统不支持 chmod，不影响功能
  }
}

/** 一次接入会话：同一批写入共用一个备份目录，并累积本工具的文件记录 */
export class WriteSession {
  readonly files: FileRecord[] = [];
  private readonly backupDir: string;
  /** 本次会话里每个文件第一次被改之前的内容（null = 原本不存在），失败时据此回滚 */
  private readonly snapshots = new Map<string, string | null>();

  constructor(
    readonly env: AgentEnv,
    /** 预演：只记录将要写的文件，不落盘 */
    readonly dryRun: boolean,
    /** 上一次接入的记录：同一文件已有"原始备份"时沿用，不把我们自己写的版本当成原始状态 */
    private readonly previous?: ToolRecord,
  ) {
    const stamp = env.now().toISOString().replace(/[:.]/g, "-");
    this.backupDir = path.join(env.configDir, "agent-backups", stamp);
  }

  /**
   * 写一个文件。首次写入前做备份；同一会话内重复写同一文件只备份一次。
   *
   * 重复执行 install 时，台账里该文件已有记录 → 沿用最初的 existed/backup，
   * 这样 agent restore 永远回到"第一次接入之前"，而不是上一次接入之后。
   */
  write(file: string, content: string, secure = false): void {
    this.snapshot(file);
    if (!this.files.some((f) => f.path === file)) {
      const prior = this.previous?.files.find((f) => f.path === file);
      if (prior) {
        this.files.push(prior);
      } else {
        const existed = fs.existsSync(file);
        const record: FileRecord = { path: file, existed };
        if (existed && !this.dryRun) {
          const rel = path.relative(this.env.home, file);
          const backup = path.join(this.backupDir, rel.startsWith("..") ? path.basename(file) : rel);
          fs.mkdirSync(path.dirname(backup), { recursive: true });
          fs.copyFileSync(file, backup);
          try {
            fs.chmodSync(backup, 0o600);
          } catch {
            // 同 writeSecure
          }
          record.backup = backup;
        }
        this.files.push(record);
      }
    }
    if (this.dryRun) return;
    if (secure) {
      writeSecure(file, content);
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }

  /** 记下文件在本次会话里第一次被改之前的内容 */
  private snapshot(file: string): void {
    if (this.dryRun || this.snapshots.has(file)) return;
    this.snapshots.set(file, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
  }

  /**
   * 回滚本次会话的全部改动：文件恢复成本次运行前的样子（原本不存在的删掉）。
   * 回到"本次运行前"而不是"第一次接入前"——重装失败不该连上次成功的配置一起抹掉。返回没能还原的路径。
   */
  rollback(): string[] {
    const failed: string[] = [];
    for (const [file, before] of this.snapshots) {
      try {
        if (before === null) fs.rmSync(file, { force: true });
        else fs.writeFileSync(file, before);
      } catch {
        failed.push(file);
      }
    }
    return failed;
  }
}

// ---------------------------------------------------------------- JSON

type Obj = Record<string, unknown>;

/** 读 JSON 对象；不存在返回 {}；损坏抛错（不静默覆盖用户写坏的配置） */
export function readJsonObject(file: string): Obj {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  if (!raw.trim()) return {};
  const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file}: not a JSON object`);
  }
  return parsed as Obj;
}

/** 读 JSON 数组（WorkBuddy 的 models.json 是顶层数组） */
export function readJsonArray(file: string): unknown[] {
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * 去掉 JSONC 的行注释与块注释（OpenCode 等允许注释）。只处理字符串外的注释，
 * 字符串里的 // （URL）不能误删。
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * 按标识合并对象数组：我方条目替换同 id 的旧条目，用户自建条目原样保留，
 * 新条目追加在后。用于 CodeBuddy / WorkBuddy 的 models 列表。
 */
export function mergeById(existing: unknown[], incoming: Obj[], key = "id"): unknown[] {
  const ours = new Map(incoming.map((x) => [String(x[key]), x]));
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const item of existing) {
    const id = item && typeof item === "object" ? String((item as Obj)[key]) : undefined;
    if (id !== undefined && ours.has(id)) {
      out.push(ours.get(id));
      seen.add(id);
    } else {
      out.push(item);
    }
  }
  for (const [id, item] of ours) {
    if (!seen.has(id)) out.push(item);
  }
  return out;
}

/** 序列化 JSON 配置（2 空格缩进 + 换行，与各工具自己写出的格式一致） */
export function toJson(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** 还原一个文件：原本存在 → 拷回备份；原本不存在 → 删除。返回是否成功 */
export function restoreFile(record: FileRecord): boolean {
  try {
    if (record.existed) {
      if (!record.backup || !fs.existsSync(record.backup)) return false;
      fs.copyFileSync(record.backup, record.path);
    } else {
      fs.rmSync(record.path, { force: true });
    }
    return true;
  } catch {
    return false;
  }
}
