/**
 * agent 接入的配置写入、合并、还原测试。全部在临时 HOME 里跑，绝不碰真实配置。
 *
 * 覆盖的是"用户最怕的事"：
 *   - 写入覆盖掉自己原有的配置（其它 provider、权限、自建模型）
 *   - 重复执行越写越乱
 *   - 卸载回不到原样
 * 以及端点协议转换（Anthropic 不带 /v1、个人版 Codex 走 chat）这些实测得来的规则。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { apiBaseOf, type Endpoint, resolveEndpoint } from "../src/core/agent/catalog.js";
import { areaCloudRegion, defaultPlanRegion } from "../src/core/config.js";
import { hasExtension, installCommandOf, isInstalled, toolOf } from "../src/core/agent/tools.js";
import { allowedModelsOf } from "../src/core/agent/key-sources.js";
import { checkModels, scopeToKey } from "../src/commands/agent.js";
import { matchesMasked, parsePicks } from "../src/core/agent/key-picker.js";
import { claudeTiersOf, CONFIGURATORS, type ConfigureInput, probeConfig, protocolOf } from "../src/core/agent/configurators.js";
import {
  type AgentEnv,
  mergeById,
  restoreFile,
  stripJsonComments,
  WriteSession,
} from "../src/core/agent/files.js";

let env: AgentEnv;
const savedShell = process.env["SHELL"];
const savedPath = process.env["PATH"];

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "thcli-agent-"));
  env = { home, configDir: path.join(home, ".thcli"), platform: "darwin", now: () => new Date("2026-10-01T00:00:00Z") };
  process.env["SHELL"] = "/bin/zsh";
  // 本机装没装 codex 等程序不能影响结果：Codex 写入会调 `codex debug models` / `codex app-server daemon`
  process.env["PATH"] = path.join(home, "bin");
});

afterEach(() => {
  fs.rmSync(env.home, { recursive: true, force: true });
  if (savedShell === undefined) delete process.env["SHELL"];
  else process.env["SHELL"] = savedShell;
  process.env["PATH"] = savedPath;
});

function write(rel: string, content: string): string {
  const file = path.join(env.home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function read(rel: string): string {
  return fs.readFileSync(path.join(env.home, rel), "utf8");
}

function input(ep: Endpoint, models = ["glm-5.3", "kimi-k3"], previousModels: string[] = []): ConfigureInput {
  return { endpoint: ep, apiKey: "sk-test-1234567890", models, defaultModel: models[0]!, previousModels };
}

const th = (): Endpoint => resolveEndpoint("th", "cn", "gz");

describe("端点解析", () => {
  it("对外只有服务地址；各协议的后缀由 apiBaseOf 按通道给出", () => {
    const ep = th();
    assert.equal(ep.origin, "https://tokenhub.tencentmaas.com");
    assert.equal(apiBaseOf(ep, "openai"), "https://tokenhub.tencentmaas.com/v1");
    // Claude Code 填服务地址本身即可，SDK 自己拼 /v1/messages
    assert.equal(apiBaseOf(ep, "anthropic"), "https://tokenhub.tencentmaas.com");
  });

  it("个人版走 /plan/v3 与 /plan/anthropic（与企业版同域名）", () => {
    const ep = resolveEndpoint("tp", "cn", "gz");
    assert.equal(ep.origin, "https://tokenhub.tencentmaas.com");
    assert.equal(apiBaseOf(ep, "openai"), "https://tokenhub.tencentmaas.com/plan/v3");
    assert.equal(apiBaseOf(ep, "anthropic"), "https://tokenhub.tencentmaas.com/plan/anthropic");
    assert.equal(apiBaseOf(resolveEndpoint("tp", "intl", "sg"), "openai"), "https://tokenhub-intl.tencentcloudmaas.com/plan/v3");
  });

  it("国际站企业版走新加坡网关", () => {
    assert.equal(apiBaseOf(resolveEndpoint("tp-ep", "intl", "sg"), "openai"), "https://tokenhub-intl.tencentcloudmaas.com/plan/v3");
  });

  it("个人版站点+地域组合不提供时报错，而不是拼出一个不存在的地址", () => {
    assert.throws(() => resolveEndpoint("tp", "cn", "sg"));
    assert.throws(() => resolveEndpoint("tp", "intl", "gz"));
  });

  it("企业版两个地域都有：国内站 sg、国际站 gz 不报错", () => {
    assert.equal(resolveEndpoint("tp-ep", "cn", "sg").origin, "https://tokenhub-intl.tencentmaas.com");
    assert.equal(resolveEndpoint("tp-ep", "intl", "gz").origin, "https://tokenhub.tencentcloudmaas.com");
  });

  it("默认地域：个人版用该站点唯一地域，企业版与按量用 gz", () => {
    assert.equal(defaultPlanRegion("tp", "cn"), "gz");
    assert.equal(defaultPlanRegion("tp", "intl"), "sg");
    assert.equal(defaultPlanRegion("tp-ep", "intl"), "gz");
  });

  it("数据面地域映射到云 API 地域（云端 Key 按地域分池）", () => {
    assert.equal(areaCloudRegion("gz"), "ap-guangzhou");
    assert.equal(areaCloudRegion("sg"), "ap-singapore");
  });

  it("只有 Claude Code 走 Anthropic 协议", () => {
    assert.equal(protocolOf("claude-code"), "anthropic");
    assert.equal(protocolOf("codex"), "openai");
  });
});

describe("Claude Code", () => {
  it("合并写入 env，保留用户原有键与 permissions；文件 0600", () => {
    write(".claude/settings.json", JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, env: { FOO: "bar" } }));
    const s = new WriteSession(env, false);
    CONFIGURATORS["claude-code"]!(input(th()), s);
    const data = JSON.parse(read(".claude/settings.json")) as { env: Record<string, string>; permissions: unknown };
    assert.deepEqual(data.permissions, { allow: ["Bash(ls)"] });
    assert.equal(data.env["FOO"], "bar");
    assert.equal(data.env["ANTHROPIC_BASE_URL"], "https://tokenhub.tencentmaas.com");
    assert.equal(data.env["ANTHROPIC_MODEL"], "glm-5.3");
    assert.equal(data.env["ENABLE_TOOL_SEARCH"], "false");
    assert.equal(fs.statSync(path.join(env.home, ".claude/settings.json")).mode & 0o777, 0o600);
  });

  it("~/.claude.json 补 hasCompletedOnboarding，保留其它状态；不进台账（卸载不回滚）", () => {
    write(".claude.json", JSON.stringify({ projects: { "/a": { x: 1 } } }));
    const s = new WriteSession(env, false);
    const out = CONFIGURATORS["claude-code"]!(input(th()), s);
    const data = JSON.parse(read(".claude.json")) as Record<string, unknown>;
    assert.equal(data["hasCompletedOnboarding"], true);
    assert.deepEqual(data["projects"], { "/a": { x: 1 } });
    assert.ok(!s.files.some((f) => f.path.endsWith(".claude.json")));
    assert.ok(out.notes.some((n) => n.includes("hasCompletedOnboarding")));
    // 已设过：不再改、不再提示
    const again = CONFIGURATORS["claude-code"]!(input(th()), new WriteSession(env, false));
    assert.ok(!again.notes.some((n) => n.includes("hasCompletedOnboarding")));
  });
});

describe("Codex", () => {
  it("保留用户的 provider 与注释；按量走 responses", () => {
    write(".codex/config.toml", '# mine\nmodel = "gpt-5"\n\n[model_providers.other]\nbase_url = "https://o"\n');
    const s = new WriteSession(env, false);
    CONFIGURATORS["codex"]!(input(th()), s);
    const text = read(".codex/config.toml");
    assert.match(text, /# mine/);
    assert.match(text, /\[model_providers\.other\]\nbase_url = "https:\/\/o"/);
    assert.match(text, /model_provider = "tokenhub"/);
    assert.match(text, /wire_api = "responses"/);
    // Key 直接写进 config.toml（0600），不碰环境变量与 shell rc
    assert.match(text, /experimental_bearer_token = "sk-test-1234567890"/);
    assert.equal(fs.statSync(path.join(env.home, ".codex", "config.toml")).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(env.configDir, "agent.env")), false);
    assert.equal(fs.existsSync(path.join(env.home, ".zshrc")), false);
  });

  it("不关 Codex 自动更新；早期写下的 check_for_update_on_startup = false 被去掉", () => {
    write(".codex/config.toml", 'check_for_update_on_startup = false\nmodel_reasoning_effort = "low"\n');
    CONFIGURATORS["codex"]!(input(th()), new WriteSession(env, false));
    const text = read(".codex/config.toml");
    assert.doesNotMatch(text, /check_for_update_on_startup/);
    assert.match(text, /model_reasoning_effort = "low"/);
  });

  it("旧版本写下的 env_key 被换成 experimental_bearer_token，同段其它键保留", () => {
    write(".codex/config.toml", '[model_providers.tokenhub]\nenv_key = "TOKENHUB_API_KEY"\nrequest_max_retries = 3\n');
    CONFIGURATORS["codex"]!(input(th()), new WriteSession(env, false));
    const text = read(".codex/config.toml");
    assert.doesNotMatch(text, /env_key/);
    assert.match(text, /request_max_retries = 3/);
    assert.match(text, /experimental_bearer_token = /);
  });

  it("个人版与企业版一样写 responses（同一套网关）", () => {
    CONFIGURATORS["codex"]!(input(resolveEndpoint("tp", "cn", "gz"), ["hy3"]), new WriteSession(env, false));
    assert.match(read(".codex/config.toml"), /wire_api = "responses"/);
  });

  it("国际站 auto 路由不支持 responses，默认模型换成第一个具体模型", () => {
    const ep = resolveEndpoint("tp-ep", "intl", "sg");
    const out = CONFIGURATORS["codex"]!(input(ep, ["auto", "glm-5.2"]), new WriteSession(env, false));
    assert.equal(out.defaultModel, "glm-5.2");
    assert.match(read(".codex/config.toml"), /^model = "glm-5.2"$/m);
  });
});

describe("CodeBuddy / WorkBuddy 的模型列表合并", () => {
  it("用户自建模型保留；上次写过、这次不再写的我方模型删掉", () => {
    write(
      ".codebuddy/models.json",
      JSON.stringify({ models: [{ id: "mine" }, { id: "old-ours" }], availableModels: ["mine", "old-ours"] }),
    );
    CONFIGURATORS["codebuddy"]!(input(th(), ["glm-5.3"], ["old-ours"]), new WriteSession(env, false));
    const data = JSON.parse(read(".codebuddy/models.json")) as { models: Array<{ id: string }>; availableModels: string[] };
    assert.deepEqual(data.models.map((m) => m.id), ["mine", "glm-5.3"]);
    assert.deepEqual(data.availableModels, ["mine", "glm-5.3"]);
  });

  it("mergeById 替换同 id、追加新 id、保持原顺序", () => {
    const out = mergeById([{ id: "a", v: 1 }, { id: "b" }], [{ id: "a", v: 2 }, { id: "c" }]);
    assert.deepEqual(out, [{ id: "a", v: 2 }, { id: "b" }, { id: "c" }]);
  });
});

describe("Kimi Code", () => {
  it("模型段的表头带引号（点号 ID），再次执行不重复", () => {
    const run = (): void => {
      CONFIGURATORS["kimi"]!(input(th()), new WriteSession(env, false));
    };
    run();
    const first = read(".kimi-code/config.toml");
    run();
    assert.equal(read(".kimi-code/config.toml"), first);
    assert.match(first, /\[models\."glm-5\.3"\]/);
    assert.ok(first.indexOf("default_provider") < first.indexOf("["));
  });
});

describe("OpenCode / OpenClaw / Pi", () => {
  it("OpenCode 只替换 provider.tokenhub，其它 provider 保留", () => {
    write(".config/opencode/opencode.json", JSON.stringify({ provider: { mine: { name: "m" } }, theme: "dark" }));
    CONFIGURATORS["opencode"]!(input(th()), new WriteSession(env, false));
    const data = JSON.parse(read(".config/opencode/opencode.json")) as Record<string, any>;
    assert.equal(data["theme"], "dark");
    assert.ok(data["provider"]["mine"]);
    assert.equal(data["provider"]["tokenhub"]["options"]["baseURL"], "https://tokenhub.tencentmaas.com/v1");
    assert.equal(data["model"], "tokenhub/glm-5.3");
  });

  it("OpenClaw 的配置里只写 Key 的变量引用，明文在 .env", () => {
    CONFIGURATORS["openclaw"]!(input(th()), new WriteSession(env, false));
    assert.doesNotMatch(read(".openclaw/openclaw.json"), /sk-test/);
    assert.match(read(".openclaw/.env"), /^TOKENHUB_API_KEY=sk-test-1234567890$/m);
  });

  it("Pi 写 providers.tokenhub", () => {
    CONFIGURATORS["pi"]!(input(th()), new WriteSession(env, false));
    const data = JSON.parse(read(".pi/agent/models.json")) as Record<string, any>;
    assert.equal(data["providers"]["tokenhub"]["api"], "openai-completions");
  });
});

describe("可逆性", () => {
  it("dry-run 不落任何文件", () => {
    const s = new WriteSession(env, true);
    CONFIGURATORS["claude-code"]!(input(th()), s);
    assert.equal(fs.existsSync(path.join(env.home, ".claude")), false);
    assert.equal(s.files.length, 1);
  });

  it("原本存在的文件还原到字节一致；原本不存在的删除", () => {
    const original = '{ "theme": "dark" }\n';
    write(".claude/settings.json", original);
    const s = new WriteSession(env, false);
    CONFIGURATORS["claude-code"]!(input(th()), s);
    CONFIGURATORS["kimi"]!(input(th()), s);
    for (const f of s.files) assert.ok(restoreFile(f));
    assert.equal(read(".claude/settings.json"), original);
    assert.equal(fs.existsSync(path.join(env.home, ".kimi-code/config.toml")), false);
  });

  it("重复接入沿用第一次的备份：还原回第一次接入之前，而不是上一次之后", () => {
    const original = '{ "theme": "dark" }\n';
    write(".claude/settings.json", original);
    const first = new WriteSession(env, false);
    CONFIGURATORS["claude-code"]!(input(th()), first);
    const second = new WriteSession(env, false, {
      tool: "claude-code",
      plan: "th",
      site: "cn",
      baseUrl: "",
      defaultModel: "",
      models: [],
      configuredAt: "",
      files: first.files,
    });
    CONFIGURATORS["claude-code"]!(input(th(), ["kimi-k3"]), second);
    for (const f of second.files) assert.ok(restoreFile(f));
    assert.equal(read(".claude/settings.json"), original);
  });

  it("status 读台账里记录的实际路径（CODEX_HOME 等覆盖下文件不在 ~/.codex）", () => {
    const custom = path.join(env.home, "custom-codex");
    process.env["CODEX_HOME"] = custom;
    try {
      const s = new WriteSession(env, false);
      const out = CONFIGURATORS["codex"]!(input(th()), s);
      const record = { tool: "codex", plan: "th", site: "cn", baseUrl: out.baseUrl, defaultModel: "", models: [], configuredAt: "", files: s.files, mainFile: out.mainFile };
      assert.equal(record.mainFile, path.join(custom, "config.toml"));
      assert.equal(probeConfig(record), "ok");
      fs.writeFileSync(record.mainFile!, "model = \"other\"\n");
      assert.equal(probeConfig(record), "changed");
    } finally {
      delete process.env["CODEX_HOME"];
    }
  });

  it("OpenClaw 的主配置是 openclaw.json（先写的 .env 不含 baseUrl）", () => {
    const s = new WriteSession(env, false);
    const out = CONFIGURATORS["openclaw"]!(input(th()), s);
    assert.equal(out.mainFile, path.join(env.home, ".openclaw", "openclaw.json"));
    const record = { tool: "openclaw", plan: "th", site: "cn", baseUrl: out.baseUrl, defaultModel: "", models: [], configuredAt: "", files: s.files, mainFile: out.mainFile };
    assert.equal(probeConfig(record), "ok");
  });

  it("claudeTiersOf 按所选顺序填档位，默认模型在 fable，不足的用默认模型", () => {
    assert.deepEqual(claudeTiersOf(["glm-5.3", "kimi-k3"], "glm-5.3"), { fable: "glm-5.3", opus: "kimi-k3", sonnet: "glm-5.3", haiku: "glm-5.3" });
    assert.deepEqual(claudeTiersOf(["a", "b", "c", "d", "e"], "c"), { fable: "c", opus: "a", sonnet: "b", haiku: "d" });
  });

  it("Claude Code：四个档位各写所选模型，未选的用默认模型", () => {
    const s = new WriteSession(env, false);
    CONFIGURATORS["claude-code"]!({ ...input(th(), ["glm-5.3", "kimi-k3", "glm-5.3-flash"]), claudeTiers: { opus: "kimi-k3", haiku: "glm-5.3-flash" } }, s);
    const e = JSON.parse(read(".claude/settings.json")).env as Record<string, string>;
    assert.equal(e["ANTHROPIC_MODEL"], "glm-5.3");
    assert.equal(e["ANTHROPIC_DEFAULT_FABLE_MODEL"], "glm-5.3");
    assert.equal(e["ANTHROPIC_DEFAULT_OPUS_MODEL"], "kimi-k3");
    assert.equal(e["ANTHROPIC_DEFAULT_SONNET_MODEL"], "glm-5.3");
    assert.equal(e["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "glm-5.3-flash");
    assert.equal(e["CLAUDE_CODE_SUBAGENT_MODEL"], "glm-5.3");
  });

});

describe("JSONC", () => {
  it("去掉注释但不误伤字符串里的 //", () => {
    const parsed = JSON.parse(stripJsonComments('{ // c\n "u": "https://a/b", /* x */ "n": 1 }')) as Record<string, unknown>;
    assert.deepEqual(parsed, { u: "https://a/b", n: 1 });
  });
});

describe("Key 名称反查", () => {
  it("服务端打码（前 5 + *** + 后 4）与明文按头尾匹配", () => {
    assert.equal(matchesMasked("sk-0e***RE1v", "sk-0eABCDEFGHIJKRE1v"), true);
    assert.equal(matchesMasked("sk-0e***RE1v", "sk-0fABCDEFGHIJKRE1v"), false);
    assert.equal(matchesMasked("sk-0e***RE1v", "sk-0eRE1v"), false);
    assert.equal(matchesMasked(undefined, "sk-0eABCDEFGHIJKRE1v"), false);
  });

  it("parsePicks 按序号或 ID 解析，保持顺序去重，有不认识的返回 undefined", () => {
    const opts = ["glm-5.3", "kimi-k3", "hy3"];
    assert.deepEqual(parsePicks("2, 1 2", opts), ["kimi-k3", "glm-5.3"]);
    assert.deepEqual(parsePicks("hy3，1", opts), ["hy3", "glm-5.3"]);
    assert.equal(parsePicks("4", opts), undefined);
    assert.equal(parsePicks("glm", opts), undefined);
  });
});

describe("安装检测（--version）", () => {
  /** 在临时 bin 目录放一个名为 exe 的脚本，--version 输出 out */
  function fakeExe(exe: string, out: string): void {
    const bin = path.join(env.home, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, exe), `#!/bin/sh\necho '${out}'\n`, { mode: 0o755 });
    process.env["PATH"] = bin;
  }

  it("同名但不是 Codex 的程序不算已安装", () => {
    fakeExe("codex", "unrelated tool 1.0");
    assert.equal(isInstalled(toolOf("codex")!, env), false);
  });

  it("--version 输出符合 Codex 的格式才算已安装", () => {
    fakeExe("codex", "codex-cli 0.153.0");
    assert.equal(isInstalled(toolOf("codex")!, env), true);
  });

  it("--version 跑不起来（如 postinstall 没执行、退出码非 0）不算已安装", () => {
    const bin = path.join(env.home, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho 'Error: claude native binary not installed' >&2\nexit 1\n", { mode: 0o755 });
    process.env["PATH"] = bin;
    assert.equal(isInstalled(toolOf("claude-code")!, env), false);
  });
});


describe("失败回滚", () => {
  it("rollback 把本次写过的文件恢复成运行前的样子，原本不存在的删除", () => {
    const existing = write(".codex/config.toml", 'model = "mine"\n');
    const s = new WriteSession(env, false);
    CONFIGURATORS["codex"]!(input(th()), s);
    assert.notEqual(fs.readFileSync(existing, "utf8"), 'model = "mine"\n');
    assert.deepEqual(s.rollback(), []);
    assert.equal(fs.readFileSync(existing, "utf8"), 'model = "mine"\n');
  });
});

describe("npm 安装命令", () => {
  it("与官方一致：npm install -g <包名>，不固定版本、不加 --ignore-scripts", () => {
    assert.deepEqual(installCommandOf(toolOf("claude-code")!), ["npm", "install", "-g", "@anthropic-ai/claude-code"]);
    assert.deepEqual(installCommandOf(toolOf("codex")!), ["npm", "install", "-g", "@openai/codex"]);
  });

  it("桌面应用 / 界面型 Agent 没有 npm 安装命令", () => {
    assert.equal(installCommandOf(toolOf("workbuddy")!), undefined);
    assert.equal(installCommandOf(toolOf("cursor")!), undefined);
  });
});

describe("Kilo Code / Pi", () => {
  it("Kilo Code 写 ~/.config/kilo/kilo.jsonc：provider.tokenhub + model，保留用户其它配置", () => {
    write(".config/kilo/kilo.jsonc", '{\n  // mine\n  "autoupdate": false\n}\n');
    const out = CONFIGURATORS["kilo-code"]!(input(th()), new WriteSession(env, false));
    const data = JSON.parse(read(".config/kilo/kilo.jsonc"));
    assert.equal(data.autoupdate, false);
    assert.equal(data.model, "tokenhub/glm-5.3");
    assert.equal(data.provider.tokenhub.options.baseURL, "https://tokenhub.tencentmaas.com/v1");
    assert.deepEqual(Object.keys(data.provider.tokenhub.models), ["glm-5.3", "kimi-k3"]);
    assert.equal(out.mainFile, path.join(env.home, ".config", "kilo", "kilo.jsonc"));
  });

  it("Pi 在 settings.json 写 defaultProvider / defaultModel，保留用户其它设置", () => {
    write(".pi/agent/settings.json", '{"theme":"dark"}');
    CONFIGURATORS["pi"]!(input(th()), new WriteSession(env, false));
    const settings = JSON.parse(read(".pi/agent/settings.json"));
    assert.deepEqual(settings, { theme: "dark", defaultProvider: "tokenhub", defaultModel: "glm-5.3" });
  });
});

describe("编辑器扩展检测", () => {
  it("在任一编辑器的扩展目录里找到 <publisher.name>-<版本> 即算已安装（大小写不敏感）", () => {
    assert.equal(hasExtension("saoudrizwan.claude-dev", env), false);
    fs.mkdirSync(path.join(env.home, ".cursor", "extensions", "SaoudRizwan.claude-dev-4.1.22"), { recursive: true });
    assert.equal(hasExtension("saoudrizwan.claude-dev", env), true);
    assert.equal(isInstalled(toolOf("cline")!, env), true);
    assert.equal(isInstalled(toolOf("roo-code")!, env), false);
  });
});

describe("Codex 模型目录的模板", () => {
  it("第三方模型关掉 OpenAI 专用开关：不用 responses lite（否则请求不带 tools）、不用 code mode、去掉多 Agent", async () => {
    const { codexCatalogFrom } = await import("../src/core/agent/configurators.js");
    const bundled = { models: [{ slug: "gpt-x", visibility: "list", supported_in_api: true, use_responses_lite: true, tool_mode: "code_mode_only", multi_agent_version: "v2", model_messages: { instructions_template: "T" }, base_instructions: "T" }] };
    const out = JSON.parse(codexCatalogFrom(JSON.stringify(bundled), ["glm-5.3"])!).models[0];
    assert.equal(out.slug, "glm-5.3");
    assert.equal(out.use_responses_lite, false);
    assert.equal(out.tool_mode, null);
    assert.equal("multi_agent_version" in out, false);
    assert.equal("base_instructions" in out, false);
    assert.deepEqual(out.supported_reasoning_levels, []);
  });
});

describe("没有 codex 程序时的 Codex 写入", () => {
  it("不写模型目录、提示装好后重跑；不提 daemon 重启", () => {
    const out = CONFIGURATORS["codex"]!(input(th()), new WriteSession(env, false));
    assert.equal(fs.existsSync(path.join(env.home, ".codex", "tokenhub-models.json")), false);
    assert.doesNotMatch(read(".codex/config.toml"), /model_catalog_json/);
    assert.ok(out.notes.some((n) => n.includes("thcli equip codex")));
  });
});

describe("模型按 Key 收窄与校验", () => {
  const catalog = { source: "api" as const, models: ["glm-5.3", "kimi-k3", "hy3"], detail: "x" };

  it("绑定全部的 Key 用整份目录；部分绑定取交集，ep- 服务 ID 不算模型", () => {
    assert.deepEqual(scopeToKey(catalog, { key: "k" }), ["glm-5.3", "kimi-k3", "hy3"]);
    assert.deepEqual(scopeToKey(catalog, { key: "k", models: ["kimi-k3", "ep-abc", "hy3"] }), ["kimi-k3", "hy3"]);
  });

  it("交集为空直接报错（这把 Key 调不通任何模型）", () => {
    assert.throws(() => scopeToKey(catalog, { key: "k", name: "only-ep", models: ["ep-abc"] }), /only-ep/);
  });

  it("云 API 来源时不在范围内的模型报错；文档 / 快照来源放行；非法字符一律报错", () => {
    assert.throws(() => checkModels(["nope"], catalog.models, "api"));
    assert.deepEqual(checkModels(["nope", "nope"], catalog.models, "doc"), ["nope"]);
    assert.throws(() => checkModels(["a;rm"], catalog.models, "doc"));
  });

  it("企业版 AllowedModels：JSON 字符串、数组、损坏值都能解析", () => {
    assert.deepEqual(allowedModelsOf('["all"]'), ["all"]);
    assert.deepEqual(allowedModelsOf(["a", "b"]), ["a", "b"]);
    assert.deepEqual(allowedModelsOf("not json"), []);
    assert.deepEqual(allowedModelsOf(undefined), []);
  });
});

describe("回滚：已有台账记录时", () => {
  it("回到本次运行前（上次接入后的内容），不是第一次接入前", () => {
    const first = new WriteSession(env, false);
    CONFIGURATORS["claude-code"]!(input(th(), ["glm-5.3"]), first);
    const afterFirst = read(".claude/settings.json");
    const previous = { tool: "claude-code", plan: "th", site: "cn", baseUrl: "", defaultModel: "glm-5.3", models: ["glm-5.3"], configuredAt: "", files: first.files };
    const second = new WriteSession(env, false, previous);
    CONFIGURATORS["claude-code"]!(input(th(), ["kimi-k3"]), second);
    assert.notEqual(read(".claude/settings.json"), afterFirst);
    assert.deepEqual(second.rollback(), []);
    assert.equal(read(".claude/settings.json"), afterFirst);
  });
});
