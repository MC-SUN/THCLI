/**
 * 各 Agent 工具的配置写入。
 *
 * 字段与写法按两份来源交叉确认：腾讯云官方接入文档（thcli-tokenhub-docs 的模板）
 * 与 tokenplan-quick-setup（真实 Key 端到端验证过）。两者不一致处以实测为准，
 * 并在对应函数注释里写明。
 *
 * 通用规则：
 *   - 一律合并写入，只动我们的 provider / 键，用户其它配置原样保留
 *   - 含 API Key 明文的文件 0600
 *   - 所有写入经 WriteSession：先备份、记台账，agent restore 可还原
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { deepMerge } from "../config.js";
import { t } from "../i18n.js";
import { apiBaseOf, type Endpoint, type ModelCapability, type WireProtocol } from "./catalog.js";
import {
  mergeById,
  readJsonArray,
  readJsonObject,
  toJson,
  type ToolRecord,
  type WriteSession,
} from "./files.js";
import {
  collapseBlankLines,
  dropRootKey,
  dropSectionKey,
  joinLines,
  removeSections,
  splitLines,
  upsertRootKey,
  upsertSection,
} from "./toml.js";
import { isProcessRunning, type ToolSpec, which } from "./tools.js";

type Obj = Record<string, unknown>;

/** provider 键 / 模型前缀（tokenhub/<model>） */
export const PROVIDER_SLUG = "tokenhub";

/** 写进各工具的厂商显示名 */
export const VENDOR = "Tencent Cloud TokenHub";

/** OpenClaw 读 Key 的环境变量名（写在它自己的 ~/.openclaw/.env 里） */
export const OPENCLAW_ENV_KEY = "TOKENHUB_API_KEY";

/** Claude Code 的模型档位（/model 菜单里的 fable / opus / sonnet / haiku，各对应一个 ANTHROPIC_DEFAULT_*_MODEL） */
export type ClaudeTier = "fable" | "opus" | "sonnet" | "haiku";

/** 档位顺序：从高到低 */
export const CLAUDE_TIERS: ClaudeTier[] = ["fable", "opus", "sonnet", "haiku"];

/**
 * 按所选模型的顺序填 Claude Code 档位：默认模型填 fable，其余依次填 opus / sonnet / haiku；
 * 不足四个时剩下的档位用默认模型；Claude Code 只有这四个槽位，第五个起不写进它的配置（列表型 Agent 照常全写）。
 */
export function claudeTiersOf(models: string[], defaultModel: string): Record<ClaudeTier, string> {
  const ordered = [defaultModel, ...models.filter((m) => m !== defaultModel)];
  return Object.fromEntries(CLAUDE_TIERS.map((tier, i) => [tier, ordered[i] ?? defaultModel])) as Record<ClaudeTier, string>;
}

/** 一次接入的输入 */
export interface ConfigureInput {
  endpoint: Endpoint;
  apiKey: string;
  models: string[];
  defaultModel: string;
  /** 上次接入写过的模型（用于清理不再存在的条目，不碰用户自建的） */
  previousModels: string[];
  /** 模型能力（云 API 来源才有），WorkBuddy 等需要声明能力的工具用 */
  capabilities?: Record<string, ModelCapability>;
  /** Claude Code 各档位的模型；未给的档位用默认模型 */
  claudeTiers?: Partial<Record<ClaudeTier, string>>;
}

/** OpenAI 兼容协议的 base（除 Claude Code 外的工具都用这个） */
const openai = (input: ConfigureInput): string => apiBaseOf(input.endpoint, "openai");

/** 一次接入的结果 */
export interface ConfigureOutcome {
  /** 该工具实际使用的 base URL（Claude 用 Anthropic 端点，其余多为 OpenAI 端点） */
  baseUrl: string;
  /** 实际默认模型（Codex 国际站 auto 会被换掉） */
  defaultModel: string;
  /** 主配置文件（含 baseUrl 的那个），status 据此判断是否仍指向 TokenHub */
  mainFile: string;
  /** 给用户的后续提示（已翻译） */
  notes: string[];
}

type Configurator = (input: ConfigureInput, s: WriteSession) => ConfigureOutcome;

const home = (s: WriteSession, ...parts: string[]): string => path.join(s.env.home, ...parts);

/** 尊重工具自己的 HOME 覆盖变量（KIMI_CODE_HOME 等） */
function envDir(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/** 删掉上次写过、这次不再写的我方条目；用户自建的不动 */
function dropStale(list: unknown[], previous: string[], current: string[], key = "id"): unknown[] {
  const stale = new Set(previous.filter((m) => !current.includes(m)));
  return list.filter((x) => !(x && typeof x === "object" && stale.has(String((x as Obj)[key]))));
}

// ---------------------------------------------------------------- Claude Code

/**
 * 官方接入文档（1823/130070、130665）要求的第二步：~/.claude.json 里 hasCompletedOnboarding = true，
 * 否则首次启动会进 Anthropic 登录引导、绕不过去。
 *
 * 这个文件是 Claude Code 自己的状态文件（项目历史、会话等，随时在改），所以不走 WriteSession：
 * 纳入台账的话 agent restore 会把它整体回滚到接入前，抹掉期间的全部状态。只在没设过时补这一个字段，
 * 卸载时保留（它只表示"已完成首次引导"，留着无害）。返回是否需要 / 做了改动。
 */
function markOnboarded(s: WriteSession): boolean {
  const file = home(s, ".claude.json");
  let data: Obj;
  try {
    data = readJsonObject(file);
  } catch {
    // 文件损坏不替用户修，交给 Claude Code 自己处理
    return false;
  }
  if (data["hasCompletedOnboarding"] === true) return false;
  if (!s.dryRun) fs.writeFileSync(file, toJson({ ...data, hasCompletedOnboarding: true }));
  return true;
}

/**
 * ~/.claude/settings.json 的 env 块。
 *
 * ANTHROPIC_BASE_URL 不带 /v1（SDK 自己拼 /v1/messages）；ANTHROPIC_MODEL 与子 Agent 用默认模型，
 * fable / opus / sonnet / haiku 四个档位各填所选模型（未选的用默认模型，即官方模板"所有槽位同一模型"的写法）；
 * ENABLE_TOOL_SEARCH 必须关（第三方模型不支持 Claude 的内置 web search）。
 * env 的值写成字符串：settings.json 的 env 按 Record<string,string> 校验，
 * 官方文档里的裸 false 在 schema 校验严格的版本上会被告警。
 */
const configureClaudeCode: Configurator = (input, s) => {
  const file = home(s, ".claude", "settings.json");
  const data = readJsonObject(file);
  // Anthropic 协议：按量填服务地址本身（SDK 自己拼 /v1/messages），套餐填 /plan/anthropic
  const base = apiBaseOf(input.endpoint, "anthropic");
  const m = input.defaultModel;
  const tierEnv = Object.fromEntries(
    CLAUDE_TIERS.map((tier) => [`ANTHROPIC_DEFAULT_${tier.toUpperCase()}_MODEL`, input.claudeTiers?.[tier] ?? m]),
  );
  const next = deepMerge(data, {
    env: {
      ANTHROPIC_BASE_URL: base,
      ANTHROPIC_AUTH_TOKEN: input.apiKey,
      ANTHROPIC_MODEL: m,
      ...tierEnv,
      CLAUDE_CODE_SUBAGENT_MODEL: m,
      ENABLE_TOOL_SEARCH: "false",
    },
  });
  s.write(file, toJson(next), true);

  const notes = [t("agent.note.newTerminal"), t("agent.note.claudeSwitch")];
  if (markOnboarded(s)) notes.push(t("agent.note.claudeOnboarding"));
  // 同时存在 API_KEY 时 Claude Code 会优先用它去打 Anthropic 官方鉴权，表现为 401
  if ((data["env"] as Obj | undefined)?.["ANTHROPIC_API_KEY"]) {
    notes.push(t("agent.note.claudeApiKeyConflict"));
  }
  return { baseUrl: base, defaultModel: m, mainFile: file, notes };
};

// ---------------------------------------------------------------- Codex

/**
 * ~/.codex/config.toml + Key 环境变量。
 *
 * wire_api 一律 responses：个人版与企业版都在同一套网关上，两种协议都可用。
 * 国际站的 auto 路由拒绝 responses 协议（400005），换成第一个具体模型。
 *
 * Key 用 provider 段的 experimental_bearer_token 直接写进 config.toml（0600），与其它 Agent 一样一个文件搞定：
 * 不需要环境变量，所以不改 shell rc、不用 setx，装完即生效（实测 Codex 0.153.0）。
 * 代价是字段带 experimental_ 前缀，Codex 未承诺长期稳定；用户自行升级 Codex 后若该字段失效，重跑 install 即可。
 * 旧版本写过的 env_key 一并删掉——两者同在时以哪个为准不明确。
 */
/**
 * Codex 的模型目录（model_catalog_json）。
 *
 * Codex 的 /model 菜单与启动时的默认模型都来自它内置的 OpenAI 模型目录，和 provider 无关：不给目录时菜单里只有 gpt-5.x，
 * 用户在菜单或启动提示里一选就会把 config.toml 的 model 改成 gpt-5.6-sol 之类，TokenHub 网关报 400004。
 * 给一份只含所选 TokenHub 模型的目录，菜单里就只有它们。
 *
 * 条目以本机 Codex 自带目录（`codex debug models --bundled`）里的一项为模板，只换 slug / 名称 / 排序：
 * 每项必须带 Codex 的系统提示（约 18KB）与 shell / 截断等一组字段，各版本格式不同，整项照抄本机版本最稳——
 * 只挑字段的话，Codex 升级后新增必填字段会导致整个配置加载失败。系统提示在模板里有两份（base_instructions 与
 * model_messages.instructions_template，后者优先），去掉重复的那份，并紧凑输出，文件约为每个模型 22KB。
 * supported_reasoning_levels 置空——Codex 就不再发 reasoning effort（实测 glm-5.3 不认 medium，报"不支持关闭思考"）。
 * 本机没装 Codex 或取不到模板时返回 undefined，不写目录（照常可用，只是菜单里仍是 OpenAI 的模型）。
 */
/**
 * 模板里只适用于 OpenAI 自家模型的开关，第三方模型一律关掉（Codex 0.160 实测）：
 *   use_responses_lite: true  → Codex 发请求时不带 tools，模型拿不到 shell 等工具，只会回"我来执行一下"却什么都不做
 *   tool_mode: code_mode_only  → 工具改走 OpenAI 的 code mode 协议，第三方模型不认
 *   multi_agent_version        → 多 Agent 协作的系统提示与工具（删除该键）
 * 这些开关在新版 bundled 目录里多数模型都打开着，不能指望"挑到的那一项"恰好是关的。
 */
const THIRD_PARTY_MODEL_OVERRIDES: Obj = { use_responses_lite: false, tool_mode: null };

function codexCatalog(models: string[]): string | undefined {
  const exe = which("codex");
  if (!exe) return undefined;
  const r = spawnSync(exe, ["debug", "models", "--bundled"], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  return codexCatalogFrom(r.stdout ?? "", models);
}

/** 由 `codex debug models --bundled` 的输出生成目录（纯函数，便于测试）；解析不了返回 undefined */
export function codexCatalogFrom(bundledJson: string, models: string[]): string | undefined {
  let template: Obj | undefined;
  try {
    const bundled = (JSON.parse(bundledJson) as { models?: Obj[] }).models ?? [];
    template = bundled.find((m) => m["visibility"] === "list" && m["supported_in_api"] === true) ?? bundled[0];
  } catch {
    return undefined;
  }
  if (!template) return undefined;
  const base: Obj = { ...template, ...THIRD_PARTY_MODEL_OVERRIDES };
  delete base["multi_agent_version"];
  const messages = base["model_messages"] as Obj | null | undefined;
  if (messages?.["instructions_template"]) delete base["base_instructions"];
  const entries = models.map((id, i) => ({
    ...base,
    slug: id,
    display_name: id,
    description: VENDOR,
    priority: i,
    visibility: "list",
    upgrade: null,
    availability_nux: null,
    supported_reasoning_levels: [],
    default_reasoning_level: null,
  }));
  return `${JSON.stringify({ models: entries })}\n`;
}

const configureCodex: Configurator = (input, s) => {
  const dir = envDir("CODEX_HOME", home(s, ".codex"));
  const file = path.join(dir, "config.toml");
  const ep = input.endpoint;
  let model = input.defaultModel;
  if (ep.site === "intl" && model === "auto") {
    model = input.models.find((x) => x !== "auto") ?? model;
  }
  const wireApi = "responses";
  const base = openai(input);

  const catalogFile = path.join(dir, "tokenhub-models.json");
  const catalog = codexCatalog([model, ...input.models.filter((m) => m !== model)]);
  if (catalog) s.write(catalogFile, catalog);

  let lines = splitLines(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
  lines = upsertRootKey(lines, "model_provider", PROVIDER_SLUG);
  lines = upsertRootKey(lines, "model", model);
  if (catalog) lines = upsertRootKey(lines, "model_catalog_json", catalogFile);
  // 自动更新留给 Codex 自己管；早期版本写过的 check_for_update_on_startup = false 一并去掉
  lines = dropRootKey(lines, "check_for_update_on_startup");
  const header = `[model_providers.${PROVIDER_SLUG}]`;
  lines = upsertSection(dropSectionKey(lines, header, "env_key"), header, {
    name: VENDOR,
    base_url: base,
    wire_api: wireApi,
    experimental_bearer_token: input.apiKey,
  });
  s.write(file, joinLines(lines), true);

  const notes = [t("agent.note.codexBearer"), t(catalog ? "agent.note.codexCatalog" : "agent.note.codexNoCatalog")];
  if (model !== input.defaultModel) {
    notes.push(t("agent.note.codexIntlAuto", { model }));
  }
  if (!s.dryRun) notes.push(restartCodexDaemon(dir));
  return { baseUrl: base, defaultModel: model, mainFile: file, notes };
};

/**
 * Codex 的 IDE 插件 / 桌面端经常驻后台的 app-server daemon 运行，daemon 只在启动时读一次配置与模型目录：
 * 改完 config.toml 不重启它，插件里的新会话仍用旧配置（实测：换好目录后不重启仍不带 tools，restart 后正常）。
 * daemon 在跑才重启；没在跑（只用终端 CLI）或命令失败不影响接入，只在结果里给手动重启的命令。
 */
function restartCodexDaemon(codexHome: string): string {
  const exe = which("codex");
  if (!exe) return t("agent.note.codexDaemonManual");
  const env = { ...process.env, CODEX_HOME: codexHome };
  const ver = spawnSync(exe, ["app-server", "daemon", "version"], { encoding: "utf8", timeout: 15_000, env });
  let running = false;
  try {
    running = (JSON.parse(ver.stdout) as { status?: string }).status === "running";
  } catch {
    // 没有 daemon（或旧版 Codex 没有这个子命令）：只用终端 CLI 的情况，新开的 codex 会读到新配置
  }
  if (!running) return t("agent.note.codexNewSession");
  const r = spawnSync(exe, ["app-server", "daemon", "restart"], { encoding: "utf8", timeout: 60_000, env });
  return t(r.status === 0 ? "agent.note.codexDaemonRestarted" : "agent.note.codexDaemonManual");
}

// ---------------------------------------------------------------- CodeBuddy

/** ~/.codebuddy/models.json：models[] 按 id 合并 + availableModels（官方模板） */
const configureCodeBuddy: Configurator = (input, s) => {
  const file = home(s, ".codebuddy", "models.json");
  const data = readJsonObject(file);
  const ours = input.models.map((id) => ({
    id,
    name: id,
    vendor: VENDOR,
    apiKey: input.apiKey,
    url: openai(input),
  }));
  const models = mergeById(dropStale((data["models"] as unknown[]) ?? [], input.previousModels, input.models), ours);
  const available = ((data["availableModels"] as unknown[]) ?? []).filter(
    (m) => !input.previousModels.includes(String(m)) || input.models.includes(String(m)),
  );
  for (const id of input.models) {
    if (!available.includes(id)) available.push(id);
  }
  s.write(file, toJson({ ...data, models, availableModels: available }), true);
  return { baseUrl: openai(input), defaultModel: input.defaultModel, mainFile: file, notes: [t("agent.note.codebuddy")] };
};

// ---------------------------------------------------------------- OpenCode

/** ~/.config/opencode/opencode.json：provider.tokenhub 整体替换 + 默认模型 */
const configureOpenCode: Configurator = (input, s) => {
  const file = home(s, ".config", "opencode", "opencode.json");
  const data = readJsonObject(file);
  const provider = { ...((data["provider"] as Obj | undefined) ?? {}) };
  provider[PROVIDER_SLUG] = {
    npm: "@ai-sdk/openai-compatible",
    name: VENDOR,
    options: { baseURL: openai(input), apiKey: input.apiKey },
    models: Object.fromEntries(input.models.map((id) => [id, { name: id }])),
  };
  const next: Obj = {
    $schema: "https://opencode.ai/config.json",
    ...data,
    provider,
    model: `${PROVIDER_SLUG}/${input.defaultModel}`,
  };
  s.write(file, toJson(next), true);
  return { baseUrl: openai(input), defaultModel: input.defaultModel, mainFile: file, notes: [] };
};

// ---------------------------------------------------------------- Kilo Code

/**
 * ~/.config/kilo/kilo.jsonc（官方接入文档 1823/131904 给出的配置文件）。Kilo CLI 是 OpenCode 的分支，
 * 配置 schema 相同（https://app.kilo.ai/config.json：provider.<id>.npm/name/options.baseURL/apiKey/models，model = "provider/model"）。
 * 文件允许注释；合并写入时注释会丢失（与 OpenCode 一样按 JSON 重写），写前已备份。
 */
const configureKiloCode: Configurator = (input, s) => {
  const file = home(s, ".config", "kilo", "kilo.jsonc");
  const data = readJsonObject(file);
  const provider = { ...((data["provider"] as Obj | undefined) ?? {}) };
  provider[PROVIDER_SLUG] = {
    npm: "@ai-sdk/openai-compatible",
    name: VENDOR,
    options: { baseURL: openai(input), apiKey: input.apiKey },
    models: Object.fromEntries(input.models.map((id) => [id, { name: id }])),
  };
  const next: Obj = { $schema: "https://app.kilo.ai/config.json", ...data, provider, model: `${PROVIDER_SLUG}/${input.defaultModel}` };
  s.write(file, toJson(next), true);
  return { baseUrl: openai(input), defaultModel: input.defaultModel, mainFile: file, notes: [t("agent.note.kiloReload")] };
};

// ---------------------------------------------------------------- OpenClaw

/** ~/.openclaw/.env 里设置一行 KEY=value，其余行保留 */
function upsertDotenv(text: string, key: string, value: string): string {
  const lines = splitLines(text).filter((l) => !new RegExp(`^\\s*${key}\\s*=`).test(l));
  lines.push(`${key}=${value}`);
  return joinLines(lines.filter((l, i) => l.trim() || i < lines.length - 1));
}

/**
 * ~/.openclaw/openclaw.json：models.providers.tokenhub（openai-completions）+
 * agents.defaults 的主模型与模型别名。Key 走同目录 .env，配置里只写 ${TOKENHUB_API_KEY}。
 */
const configureOpenClaw: Configurator = (input, s) => {
  const dir = home(s, ".openclaw");
  const envFile = path.join(dir, ".env");
  s.write(envFile, upsertDotenv(fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "", OPENCLAW_ENV_KEY, input.apiKey), true);

  const file = path.join(dir, "openclaw.json");
  const data = readJsonObject(file);
  const modelsCfg = { ...((data["models"] as Obj | undefined) ?? {}) };
  const providers = { ...((modelsCfg["providers"] as Obj | undefined) ?? {}) };
  providers[PROVIDER_SLUG] = {
    baseUrl: openai(input),
    apiKey: `\${${OPENCLAW_ENV_KEY}}`,
    api: "openai-completions",
    models: input.models.map((id) => ({ id, name: id, reasoning: id !== "auto" })),
  };
  modelsCfg["mode"] ??= "merge";
  modelsCfg["providers"] = providers;

  const agents = { ...((data["agents"] as Obj | undefined) ?? {}) };
  const defaults = { ...((agents["defaults"] as Obj | undefined) ?? {}) };
  // 先摘掉旧的 tokenhub/* 别名，再按本次列表重建，避免残留已下线的模型
  const aliases = Object.fromEntries(
    Object.entries((defaults["models"] as Obj | undefined) ?? {}).filter(([k]) => !k.startsWith(`${PROVIDER_SLUG}/`)),
  );
  for (const id of input.models) {
    aliases[`${PROVIDER_SLUG}/${id}`] = { alias: id };
  }
  defaults["models"] = aliases;
  defaults["model"] = { ...((defaults["model"] as Obj | undefined) ?? {}), primary: `${PROVIDER_SLUG}/${input.defaultModel}` };
  agents["defaults"] = defaults;

  s.write(file, toJson({ ...data, models: modelsCfg, agents }), true);
  return {
    baseUrl: openai(input),
    defaultModel: input.defaultModel,
    mainFile: file,
    notes: [t("agent.note.openclaw", { model: `${PROVIDER_SLUG}/${input.defaultModel}` })],
  };
};

// ---------------------------------------------------------------- Kimi Code

/**
 * ~/.kimi-code/config.toml（KIMI_CODE_HOME 可覆盖）。
 * 根级 default_provider/default_model 必须在任何表头之前；含点号的模型 ID 在表头里
 * 必须加引号，否则被解析成嵌套表、与平级段冲突导致整个文件加载失败。
 */
const configureKimi: Configurator = (input, s) => {
  const file = path.join(envDir("KIMI_CODE_HOME", home(s, ".kimi-code")), "config.toml");
  let lines = splitLines(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
  const managed = new Set([...input.models, ...input.previousModels].map((m) => `models.${m}`));
  lines = collapseBlankLines(removeSections(lines, managed));
  lines = upsertRootKey(lines, "default_provider", PROVIDER_SLUG);
  lines = upsertRootKey(lines, "default_model", input.defaultModel);
  lines = upsertSection(lines, `[providers.${PROVIDER_SLUG}]`, {
    type: "openai",
    base_url: openai(input),
    api_key: input.apiKey,
  });
  for (const id of input.models) {
    lines = upsertSection(lines, `[models."${id}"]`, {
      provider: PROVIDER_SLUG,
      model: id,
      display_name: id,
      max_context_size: 128000,
    });
  }
  s.write(file, joinLines(lines), true);
  return { baseUrl: openai(input), defaultModel: input.defaultModel, mainFile: file, notes: [] };
};

// ---------------------------------------------------------------- Pi

/** ~/.pi/agent/models.json（PI_CODING_AGENT_DIR / PI_CONFIG_DIR 可覆盖） */
const configurePi: Configurator = (input, s) => {
  const dir =
    process.env["PI_CODING_AGENT_DIR"] ||
    path.join(envDir("PI_CONFIG_DIR", home(s, ".pi")), "agent");
  const file = path.join(dir, "models.json");
  const data = readJsonObject(file);
  const providers = { ...((data["providers"] as Obj | undefined) ?? {}) };
  providers[PROVIDER_SLUG] = {
    baseUrl: openai(input),
    api: "openai-completions",
    apiKey: input.apiKey,
    models: input.models.map((id) => ({ id, name: id })),
  };
  s.write(file, toJson({ ...data, providers }), true);
  // 默认模型在同目录的 settings.json：defaultProvider 与 defaultModel 都设了才生效，否则 Pi 用第一个可用模型
  const settingsFile = path.join(dir, "settings.json");
  const settings = readJsonObject(settingsFile);
  s.write(settingsFile, toJson({ ...settings, defaultProvider: PROVIDER_SLUG, defaultModel: input.defaultModel }));
  return { baseUrl: openai(input), defaultModel: input.defaultModel, mainFile: file, notes: [] };
};

// ---------------------------------------------------------------- WorkBuddy

/**
 * ~/.workbuddy/models.json（顶层数组）。条目格式按真实用户手填的条目反推（quick-setup）。
 * WorkBuddy 运行中写入会在它退出时被内存里的旧列表覆盖 → 检测到运行直接中止。
 */
const configureWorkBuddy: Configurator = (input, s) => {
  if (!s.dryRun && isProcessRunning("WorkBuddy", s.env.platform)) {
    throw new Error(t("agent.err.workbuddyRunning"));
  }
  const file = home(s, ".workbuddy", "models.json");
  const ours = input.models.map((id) => ({
    id,
    name: `TokenHub / ${id}`,
    vendor: VENDOR,
    url: `${openai(input)}/chat/completions`,
    apiKey: input.apiKey,
    supportsToolCall: true,
    // 能力取自模型广场 Tags；拿不到（文档 / 快照来源）时保守按纯文本，用户可在 WorkBuddy 里再勾选
    supportsImages: input.capabilities?.[id]?.vision ?? false,
    supportsReasoning: input.capabilities?.[id]?.reasoning ?? id !== "auto",
    maxInputTokens: 1000000,
    maxOutputTokens: 131072,
  }));
  const merged = mergeById(dropStale(readJsonArray(file), input.previousModels, input.models), ours);
  s.write(file, toJson(merged), true);
  return { baseUrl: openai(input), defaultModel: input.defaultModel, mainFile: file, notes: [t("agent.note.workbuddy")] };
};

/** 文件型工具 → 写入函数 */
export const CONFIGURATORS: Record<string, Configurator> = {
  "claude-code": configureClaudeCode,
  codex: configureCodex,
  codebuddy: configureCodeBuddy,
  opencode: configureOpenCode,
  "kilo-code": configureKiloCode,
  openclaw: configureOpenClaw,
  kimi: configureKimi,
  pi: configurePi,
  workbuddy: configureWorkBuddy,
};

/**
 * 界面型 Agent 的填写指引（Key 只显示脱敏值）：先说在哪个界面，再逐项列出字段。
 * 入口与字段名照抄腾讯云官方接入文档（1823/130933 Cursor、130932 Cline、131905 Roo Code、132296 Trae）。
 */
export function guiGuide(tool: ToolSpec, input: ConfigureInput, maskedKey: string): string[] {
  const base = openai(input);
  const rows: Record<string, Array<[string, string]>> = {
    cursor: [
      ["OpenAI API Key", maskedKey],
      ["Override OpenAI Base URL", base],
      ["Add Custom model", t("agent.guide.cursorAddModel", { model: input.defaultModel })],
    ],
    cline: [
      ["API Provider", "OpenAI Compatible"],
      ["Base URL", base],
      ["OpenAI Compatible API Key", maskedKey],
      ["Model ID", input.defaultModel],
    ],
    "roo-code": [
      ["API 提供商 / API Provider", "OpenAI Compatible"],
      ["OpenAI 基础 URL / Base URL", base],
      ["API 密钥 / API Key", maskedKey],
      ["模型 / Model", t("agent.guide.customModel", { model: input.defaultModel })],
    ],
    trae: [
      ["API 格式", "OpenAI Chat Completions"],
      ["自定义请求地址", base],
      ["模型 ID", input.defaultModel],
      ["API 密钥", maskedKey],
    ],
  };
  const lines = (rows[tool.key] ?? []).map(([k, v]) => `    ${k}: ${v}`);
  return [
    `    ${t(`agent.guide.where.${tool.key}`)}`,
    ...lines,
    `    ${t("agent.guide.models", { models: input.models.join(", ") })}`,
    ...(tool.key === "cursor" ? [`    ${t("agent.guide.cursorPro")}`] : []),
    `    ${t("agent.guide.doc", { url: tool.docUrl })}`,
  ];
}

/** 工具使用的接口协议：只有 Claude Code 走 Anthropic，其余都是 OpenAI 兼容 */
export function protocolOf(tool: string): WireProtocol {
  return tool === "claude-code" ? "anthropic" : "openai";
}

/**
 * 判断已接入工具的主配置是否仍指向记录的 base URL（status 用）。
 * 读台账里记录的实际路径——CODEX_HOME / KIMI_CODE_HOME 等覆盖下文件不在 ~/ 默认位置。
 */
export function probeConfig(record: ToolRecord): "ok" | "changed" | "missing" {
  const file = record.mainFile ?? record.files[0]?.path;
  if (!file) return "missing";
  try {
    return fs.readFileSync(file, "utf8").includes(record.baseUrl) ? "ok" : "changed";
  } catch {
    return "missing";
  }
}
