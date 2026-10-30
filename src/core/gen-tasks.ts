/**
 * +gen 提交过的异步任务的本地记录（~/.thcli/gen-tasks.jsonl）。
 *
 * 为什么要记：任务在平台侧，CLI 只在提交时把任务 ID 打印一次。视频要等几分钟，
 * 用了 --no-wait、等待超时、或者终端关了，ID 就找不回来——钱花了却取不到结果。
 *
 * 追加写（JSONL）：提交时写一行，状态变化时再写一行，读取时按任务 ID 合并、后写的覆盖先写的。
 * 除压缩外不做"读-改-写整个文件"：多个终端同时生成时不会互相覆盖；
 * 压缩是唯一例外，rename 前重读补回窗口内的新行（见 compactIfLarge），残余窗口为微秒级。
 *
 * 不记 API Key，也不记结果 URL（临时签名地址，约 12 小时失效，记了也没用；要结果就再查一次）。
 * 提示词可能涉及隐私，文件权限 0600。写失败不影响生成本身。
 */
import fs from "node:fs";
import path from "node:path";

import type { GlobalArgs } from "./credentials.js";
import { CONFIG_DIR } from "./paths.js";
import type { MediaKind, TaskState } from "./gen-registry.js";

/** 记录文件路径 */
const GEN_TASKS_PATH = path.join(CONFIG_DIR, "gen-tasks.jsonl");

/** 提示词只留开头：列表里够认出是哪个任务即可 */
const PROMPT_PREVIEW_CHARS = 60;

/** 文件超过这么多行就压缩成每个任务一行、只留最近的 KEEP_TASKS 个 */
const COMPACT_AT_LINES = 2000;
const KEEP_TASKS = 500;

/** 一个任务的记录 */
export interface GenTask {
  taskId: string;
  /** 提交用的接口 ID（早期记录没有，按模型推断：同一模型在各接口的查询方式一致） */
  api?: string;
  model: string;
  kind: MediaKind;
  /** 提示词开头（截断） */
  prompt: string;
  /** 提交时间，ISO 8601 */
  createdAt: string;
  /** 最近一次已知状态 */
  state: TaskState;
  /** 状态最近更新时间 */
  updatedAt: string;
  /** 归属：查询要用同一账号 / 站点 / 地域的 Key */
  profile: string;
  site: string;
  area: string;
  /** 已下载到本地的文件（--output 时） */
  saved?: string[];
}

function appendLine(file: string, record: Partial<GenTask> & { taskId: string }): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // 记录写失败不能影响生成：任务已经提交、ID 也已打印
  }
}

/** 提交成功后记一条 */
export function recordSubmitted(
  task: Omit<GenTask, "state" | "updatedAt">,
  file: string = GEN_TASKS_PATH,
): void {
  appendLine(file, {
    ...task,
    // 按 code point 截断（slice 会把 emoji 等代理对截成半个字符）
    prompt: Array.from(task.prompt).slice(0, PROMPT_PREVIEW_CHARS).join(""),
    state: "queued",
    updatedAt: task.createdAt,
  });
  compactIfLarge(file);
}

/**
 * 状态变化时追加一条（只写变化的字段，读取时合并）。
 * 状态与下载文件都和已有记录相同就不写：对已完成的任务反复 `+gen status <接口> <任务ID>` 不会堆出重复行。
 * 没有提交记录的任务（不是本机提交的）不写：读取时也没法展示，只会堆垃圾行。
 */
export function recordState(
  taskId: string,
  state: TaskState,
  now: Date,
  saved?: string[],
  file: string = GEN_TASKS_PATH,
): void {
  const known = findTask(taskId, file);
  if (!known) return;
  const savedChanged = Boolean(saved?.length) && JSON.stringify(saved) !== JSON.stringify(known.saved);
  if (known.state === state && !savedChanged) return;
  appendLine(file, { taskId, state, updatedAt: now.toISOString(), ...(saved?.length ? { saved } : {}) });
}

/** 读全部记录：按任务 ID 合并，按提交时间倒序 */
export function loadTasks(file: string = GEN_TASKS_PATH): GenTask[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const merged = new Map<string, GenTask>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const { endpoint, ...row } = JSON.parse(line) as Partial<GenTask> & { taskId?: string; endpoint?: string };
      if (!row.taskId) continue;
      // 改名前的记录把接口 ID 存在 endpoint 字段
      if (endpoint && !row.api) row.api = endpoint;
      merged.set(row.taskId, { ...(merged.get(row.taskId) as GenTask), ...row } as GenTask);
    } catch {
      // 半行（写入中断）或手工改坏的行：跳过，不让一行坏数据挡住整个列表
    }
  }
  // 只有状态更新、没有提交记录的行（提交记录被压缩掉或来自别的机器）没法展示，丢弃
  return [...merged.values()].filter((x) => x.model && x.createdAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 按任务 ID 找一条 */
export function findTask(taskId: string, file: string = GEN_TASKS_PATH): GenTask | undefined {
  return loadTasks(file).find((x) => x.taskId === taskId);
}

/**
 * 查这个任务该用的账号 / 站点：命令行显式给了就用命令行的，否则用提交时的。
 * 任务只能用提交它的账号、站点下的 Key 查，用当前默认的去查会查不到。
 */
export function scopeOf(task: GenTask, globals: GlobalArgs): GlobalArgs {
  return { ...globals, profile: globals.profile ?? task.profile, site: globals.site ?? task.site };
}

/** 提交超过这么久仍未完成的任务不再自动刷新：正常生成最多几十分钟，这么久没结果多半已被平台清理 */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** 列表刷新时需要向平台查询的任务：未到终态、且不太旧 */
export function needsRefresh(task: GenTask, now: Date): boolean {
  if (task.state === "succeeded" || task.state === "failed") return false;
  return now.getTime() - Date.parse(task.createdAt) < STALE_AFTER_MS;
}

/** 并发上限为 limit 地对每一项执行 fn（不引入依赖的最小实现） */
export async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * 文件过大时重写成"每任务一行"，只留最近的若干个。
 * 压缩是本模块唯一一次"读-改-写整个文件"，与追加写的并发承诺冲突——
 * rename 前重读原文件、把压缩窗口内其他终端追加的行按内容比对补回（合并语义下后写的自然覆盖），
 * 丢行窗口从整个压缩耗时（秒级）缩到重读与 rename 之间的微秒级。
 */
function compactIfLarge(file: string): void {
  try {
    const text = fs.readFileSync(file, "utf8");
    if (text.split("\n").length <= COMPACT_AT_LINES) return;
    const kept = loadTasks(file).slice(0, KEEP_TASKS).reverse();
    // 快照读完后别的进程可能又追加过行（新任务提交 / 老任务状态更新）：补回，别让压缩吃掉它们
    const seen = new Set(text.split("\n"));
    const fresh = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() && !seen.has(line));
    // tmp 带进程号与时间戳：两个终端同时压缩时不互踩对方的临时文件
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, [...kept.map((x) => JSON.stringify(x)), ...fresh].join("\n") + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // 压缩失败只是文件大一点，下次再试
  }
}
