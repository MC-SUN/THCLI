/**
 * equip 完整接入的 API Key 选择：按量 / 个人版 / 企业版共用一套交互。
 *
 * 三种通道的 Key 来源不同，用 KeySource 抽象：
 *   按量 th    该地域的 API Key 列表（云端按地域分池），可新建
 *   企业版 tp-ep 某个套餐下的专属 Key 列表
 *   个人版 tp    账号下唯一一把共享 Key
 * 交互：自动（按量：thcli-key；企业版：列表第一把可用的；个人版：共享 Key）/ 从列表挑 / 新建（仅按量）/ 粘贴。
 *
 * Agent 用的 Key 只从云端来源选（或 --api-key / 粘贴），与 thcli 自己的本地 keystore（+chat 用）无关：
 * 这里不读也不写本地。选出的 Key 带上它能调的模型范围，供调用方把模型列表收窄到这把 Key 实际可用的。
 *
 * 粘贴 / --api-key 的明文靠打码形式反查名称与范围：列表接口只返回服务端打码的 Key（按量形如 sk-0e***RE1v，
 * 企业版 sk-tp-****ge30），按"明文以打码的头开头、以打码的尾结尾"匹配。
 */
import { printTable } from "../format.js";
import { t } from "../i18n.js";
import { ask } from "../prompt.js";

/** 列表里一把 Key 的摘要（ApiKey 为服务端打码形式） */
export interface KeyBrief {
  id: string;
  name?: string;
  masked?: string;
  enabled: boolean;
  /** 列表里额外显示的一列（按量：绑定范围；企业版：可用模型） */
  scope?: string;
  /** 只能调部分模型时的提示（调别的模型会 401） */
  partial?: boolean;
  /** 这把 Key 能调的模型 ID；undefined = 来源下的全部模型 */
  models?: string[];
  createdAt?: string;
}

/** 一种通道的 Key 来源 */
export interface KeySource {
  /** 给用户看的来源说明，如"ap-guangzhou 的按量 Key""企业版套餐 tp-ent-xxx 的专属 Key" */
  label: string;
  list(): Promise<KeyBrief[]>;
  reveal(id: string): Promise<string | undefined>;
  /** 能新建时提供：返回新 Key 的 id */
  create?(name: string): Promise<string | undefined>;
  /** 新建时的默认名称 */
  defaultName?: string;
  /** "自动"选项：返回明文；不提供则自动 = 列表里第一把可用的 */
  auto?(): Promise<PickedKey | undefined>;
  /** "自动"选项的说明文字 */
  autoLabel?: string;
  /** 来源里最多只有一把（个人版共享 Key）：没有"从列表挑"可言 */
  single?: boolean;
}

/** 选出的 Key */
export interface PickedKey {
  key: string;
  name?: string;
  /** 能调的模型 ID；undefined = 来源下的全部模型 */
  models?: string[];
  /** 名称与范围已从列表得知（从列表挑出的）；否则调用方按打码反查补齐 */
  resolved?: boolean;
}

/** 列表最多显示多少行（一屏看得完、又不至于刷屏）；更多的靠名称搜索 */
export const SHOW_LIMIT = 20;

/** 服务端打码的 Key 是否对应这把明文：打码前后的明文片段都吻合 */
export function matchesMasked(masked: string | undefined, plaintext: string): boolean {
  const m = /^([^*]+)\*+([^*]+)$/.exec(masked ?? "");
  if (!m) return false;
  const [, head, tail] = m;
  return plaintext.length > head!.length + tail!.length && plaintext.startsWith(head!) && plaintext.endsWith(tail!);
}

/** 按序号（1 起）或 ID 解析逗号 / 空格分隔的输入，保持顺序、去重；有无法识别的项返回 undefined */
export function parsePicks(answer: string, options: string[]): string[] | undefined {
  const picked: string[] = [];
  for (const token of answer.split(/[\s,，]+/).filter(Boolean)) {
    const hit = (/^\d+$/.test(token) ? options[Number(token) - 1] : undefined) ?? options.find((m) => m === token);
    if (!hit) return undefined;
    if (!picked.includes(hit)) picked.push(hit);
  }
  return picked;
}

/** 来源里与这把明文对应的 Key；查不到、多把吻合（不冒认）或查询失败返回 undefined */
export async function findKeyMeta(source: KeySource, plaintext: string): Promise<KeyBrief | undefined> {
  try {
    const hits = (await source.list()).filter((k) => matchesMasked(k.masked, plaintext));
    return hits.length === 1 ? hits[0] : undefined;
  } catch {
    return undefined;
  }
}

async function revealPicked(source: KeySource, k: KeyBrief): Promise<PickedKey> {
  const plaintext = await source.reveal(k.id);
  if (!plaintext) throw new Error(t("provision.noSecret"));
  return { key: plaintext, name: k.name, models: k.models, resolved: true };
}

function printKeys(keys: KeyBrief[]): void {
  printTable(
    ["#", "NAME", "APIKEY", "SCOPE", "CREATED"],
    keys.map((k, i) => [String(i + 1), k.name ?? "", k.masked ?? "", k.scope ?? "", k.createdAt ?? ""]),
  );
}

/**
 * 从列表挑一把。列表在进来前已整个取回（各来源都翻完所有页），这里只在本地筛选，不再调接口。
 * 只显示可用的、最近的 SHOW_LIMIT 把；输入序号或 Key ID 选中，其它文字按名称 / ID 子串搜索后重新显示。
 * 搜索是在已取回的全量列表上做的（各来源都翻完所有页），所以没显示出来的也能搜到。
 */
async function pickFromList(source: KeySource): Promise<PickedKey | undefined> {
  const all = (await source.list()).filter((k) => k.enabled);
  if (!all.length) {
    console.log(t("agent.key.listEmpty", { source: source.label }));
    return undefined;
  }
  let shown = all.slice(0, SHOW_LIMIT);
  console.log(t("agent.key.listHeader", { source: source.label, count: all.length, shown: shown.length }));
  for (;;) {
    printKeys(shown);
    const answer = (await ask(t("agent.key.listPrompt")))?.trim() ?? "";
    if (!answer) throw new Error(t("agent.err.noSelection"));
    // 只认序号与 Key ID（唯一）；名称可以重名，一律当搜索词，不拿名称直接选
    const picked = (/^\d+$/.test(answer) ? shown[Number(answer) - 1] : undefined) ?? all.find((k) => k.id === answer);
    if (picked) {
      if (picked.partial) console.log(t("agent.key.partialBind", { name: picked.name ?? picked.id }));
      return revealPicked(source, picked);
    }
    const needle = answer.toLowerCase();
    const matched = all.filter((k) => (k.name ?? "").toLowerCase().includes(needle) || k.id.toLowerCase().includes(needle));
    if (!matched.length) {
      console.log(t("agent.key.searchNone", { text: answer }));
      continue;
    }
    shown = matched.slice(0, SHOW_LIMIT);
    console.log(t("agent.key.searchHit", { text: answer, count: matched.length, shown: shown.length }));
  }
}

/** 新建一把（问名称） */
async function createNew(source: KeySource): Promise<PickedKey> {
  const fallback = source.defaultName ?? "thcli-key";
  const name = (await ask(t("agent.key.newName", { fallback })))?.trim() || fallback;
  const id = await source.create!(name);
  if (!id) throw new Error(t("provision.noKeyId"));
  console.log(t("agent.key.created", { name, source: source.label }));
  // 新建的 Key 绑定全部模型（BindType=all）
  return revealPicked(source, { id, name, enabled: true });
}

/** 自动：来源自带的策略，否则列表里第一把可用的（非交互 / --yes 时直接用） */
export async function chooseAuto(source: KeySource): Promise<PickedKey | undefined> {
  if (source.auto) return source.auto();
  const first = (await source.list()).find((k) => k.enabled);
  return first ? revealPicked(source, first) : undefined;
}

/** 选项菜单：返回所选动作 */
async function menu(options: Array<[string, string]>): Promise<string> {
  options.forEach(([, label], i) => console.log(`  ${i + 1}. ${label}`));
  const answer = (await ask(t("agent.key.choose")))?.trim() ?? "";
  return options[Number(answer) - 1]?.[0] ?? options[0]![0];
}

/** 选 Agent 用的 Key：自动 / 从列表挑 / 新建 / 粘贴；全部放弃返回 undefined */
export async function chooseKey(source: KeySource, plan: string): Promise<PickedKey | undefined> {
  console.log(t("agent.key.header", { source: source.label }));
  const options: Array<[string, string]> = [["auto", source.autoLabel ?? t("agent.key.opt.autoFirst")]];
  if (!source.single) options.push(["pick", t("agent.key.opt.pick")]);
  if (source.create) options.push(["create", t("agent.key.opt.create")]);
  options.push(["paste", t("agent.key.opt.paste")]);
  const action = await menu(options);
  if (action === "pick") return pickFromList(source);
  if (action === "create") return createNew(source);
  if (action === "paste") {
    const typed = (await ask(t("agent.key.prompt", { plan }), true))?.trim();
    return typed ? { key: typed } : undefined;
  }
  return chooseAuto(source);
}
