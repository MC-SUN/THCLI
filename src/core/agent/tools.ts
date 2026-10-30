/**
 * 支持接入的 Agent 工具注册表：检测是否已安装、怎么装、配置写在哪。
 *
 * 声明式：新增工具只在 TOOLS 里加一项 + 在 configurators.ts 里加对应写入函数。
 *
 * 检测规则：
 *   1. installPaths 任一存在（桌面应用 / 官方独立安装器）→ 已安装；编辑器扩展看各编辑器扩展目录（extensionId）
 *   2. PATH 上找到可执行文件后跑一次 `<exe> --version`，输出命中该工具的 versionPattern 才算。
 *      codex / pi 这类通用名会撞同名程序，看路径或启动脚本里的字符串不可靠（路径本身就含 codex），
 *      看它自己报的版本最直接；也能识别出"装了但跑不起来"（如 postinstall 没执行）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { AgentEnv } from "./files.js";

/** 接入方式：file 写配置文件；gui 只能打印填写项 */
export type ToolMode = "file" | "gui";

/** 一个工具 */
export interface ToolSpec {
  key: string;
  name: string;
  mode: ToolMode;
  /** PATH 上的命令名 */
  exe?: string;
  /** `<exe> --version` 输出的特征（实测各版本的输出格式） */
  versionPattern?: RegExp;
  /** 安装位置探测（相对 HOME 的路径用 ~/ 开头） */
  installPaths?: string[];
  /** 编辑器扩展 ID（publisher.name）：在 VS Code / Cursor / Windsurf 等的扩展目录里找 <id>-<版本> */
  extensionId?: string;
  /** npm 包名（未安装时用 npm install -g 装最新版） */
  npm?: { pkg: string };
  /** 官方接入文档（国内站） */
  docUrl: string;
  /** 桌面应用的官方下载页（npm 装不了，未安装时引导用户自己下载） */
  downloadUrl?: string;
  /** 主配置文件（相对 HOME），list/status 展示用 */
  configPath?: string;
}

/** 支持的 Agent（顺序即选择菜单里的顺序） */
export const TOOLS: ToolSpec[] = [
  {
    key: "claude-code",
    name: "Claude Code",
    mode: "file",
    exe: "claude",
    // 2.1.206 (Claude Code)
    versionPattern: /\(Claude Code\)/,
    installPaths: ["~/.local/share/claude/versions"],
    npm: { pkg: "@anthropic-ai/claude-code" },
    docUrl: "https://cloud.tencent.com/document/product/1823/131903",
    configPath: ".claude/settings.json",
  },
  {
    key: "codex",
    name: "Codex CLI",
    mode: "file",
    exe: "codex",
    // codex-cli 0.153.0
    versionPattern: /^codex-cli \d/m,
    npm: { pkg: "@openai/codex" },
    docUrl: "https://cloud.tencent.com/document/product/1823/133532",
    configPath: ".codex/config.toml",
  },
  {
    key: "codebuddy",
    name: "CodeBuddy Code",
    mode: "file",
    exe: "codebuddy",
    versionPattern: /\d+\.\d+\.\d+/,
    npm: { pkg: "@tencent-ai/codebuddy-code" },
    docUrl: "https://cloud.tencent.com/document/product/1823/131901",
    configPath: ".codebuddy/models.json",
  },
  {
    key: "opencode",
    name: "OpenCode",
    mode: "file",
    exe: "opencode",
    versionPattern: /^\d+\.\d+\.\d+/m,
    npm: { pkg: "opencode-ai" },
    docUrl: "https://cloud.tencent.com/document/product/1823/130936",
    configPath: ".config/opencode/opencode.json",
  },
  {
    key: "openclaw",
    name: "OpenClaw",
    mode: "file",
    exe: "openclaw",
    versionPattern: /\d{4}\.\d+\.\d+/,
    npm: { pkg: "openclaw" },
    docUrl: "https://cloud.tencent.com/document/product/1823/130935",
    configPath: ".openclaw/openclaw.json",
  },
  {
    key: "kimi",
    name: "Kimi Code",
    mode: "file",
    exe: "kimi",
    versionPattern: /\d+\.\d+\.\d+/,
    npm: { pkg: "@moonshot-ai/kimi-code" },
    docUrl: "https://cloud.tencent.com/document/product/1823/130051",
    configPath: ".kimi-code/config.toml",
  },
  {
    key: "pi",
    name: "Pi",
    mode: "file",
    exe: "pi",
    versionPattern: /\d+\.\d+\.\d+/,
    npm: { pkg: "@earendil-works/pi-coding-agent" },
    docUrl: "https://cloud.tencent.com/document/product/1823/130051",
    configPath: ".pi/agent/models.json",
  },
  {
    key: "workbuddy",
    name: "WorkBuddy",
    mode: "file",
    installPaths: [
      "/Applications/WorkBuddy.app",
      "/Applications/Tencent WorkBuddy.app",
      "~/Applications/WorkBuddy.app",
      "~/Applications/Tencent WorkBuddy.app",
      "${LOCALAPPDATA}/Programs/WorkBuddy/WorkBuddy.exe",
      "${LOCALAPPDATA}/Programs/Tencent WorkBuddy/WorkBuddy.exe",
    ],
    docUrl: "https://cloud.tencent.com/document/product/1823/131902",
    // workbuddy.qq.com 302 到这里（2026-10-04 实测）
    downloadUrl: "https://www.codebuddy.cn/work/",
    configPath: ".workbuddy/models.json",
  },
  {
    key: "cursor",
    name: "Cursor",
    mode: "gui",
    installPaths: ["/Applications/Cursor.app", "~/.cursor", "${LOCALAPPDATA}/Programs/cursor/Cursor.exe"],
    docUrl: "https://cloud.tencent.com/document/product/1823/130933",
  },
  // Cline / Roo Code 是编辑器扩展，配置存在编辑器内部数据库与系统钥匙串，没有可写的配置文件，只能在界面里填
  {
    key: "cline",
    name: "Cline",
    mode: "gui",
    extensionId: "saoudrizwan.claude-dev",
    docUrl: "https://cloud.tencent.com/document/product/1823/130932",
  },
  {
    key: "roo-code",
    name: "Roo Code",
    mode: "gui",
    extensionId: "rooveterinaryinc.roo-cline",
    docUrl: "https://cloud.tencent.com/document/product/1823/131905",
  },
  // Kilo Code 扩展以 Kilo CLI 为后端（CLI 是 OpenCode 的分支），配置在 ~/.config/kilo/kilo.jsonc，可以写文件
  {
    key: "kilo-code",
    name: "Kilo Code",
    mode: "file",
    extensionId: "kilocode.kilo-code",
    installPaths: ["~/.config/kilo"],
    exe: "kilo",
    versionPattern: /\d+\.\d+\.\d+/,
    docUrl: "https://cloud.tencent.com/document/product/1823/131904",
    configPath: ".config/kilo/kilo.jsonc",
  },
  {
    key: "trae",
    name: "Trae",
    mode: "gui",
    installPaths: ["/Applications/Trae.app", "/Applications/Trae CN.app", "~/.trae-cn", "~/.trae"],
    docUrl: "https://cloud.tencent.com/document/product/1823/132296",
  },
];

/** 按 key 找工具 */
export function toolOf(key: string): ToolSpec | undefined {
  return TOOLS.find((t) => t.key === key);
}

/** 展开 ~ 与 ${VAR}；未定义的变量保留原样（exists 判 false，跨平台安全） */
export function expandPath(p: string, env: AgentEnv): string {
  const withHome = p.startsWith("~/") ? path.join(env.home, p.slice(2)) : p;
  return withHome.replace(/\$\{(\w+)\}/g, (m, name: string) => process.env[name] ?? m);
}

/** PATH 上找可执行文件（Windows 补 .cmd/.exe） */
export function which(exe: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const exts = platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, exe + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // 继续找
      }
    }
  }
  return undefined;
}

/** 跑 --version 的超时：正常几百毫秒；首次启动要解压 / 初始化的工具留足余量 */
const VERSION_TIMEOUT_MS = 15_000;

/** `<exe> --version` 的输出（stdout + stderr）；跑不起来返回 undefined */
export function versionOutput(exe: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const r = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: VERSION_TIMEOUT_MS, shell: platform === "win32" });
  if (r.error || r.status !== 0) return undefined;
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

/** 各编辑器的扩展目录（相对 HOME）：VS Code 及其分支都把扩展装在 <目录>/<publisher.name>-<版本> */
const EXTENSION_DIRS = [".vscode/extensions", ".vscode-insiders/extensions", ".cursor/extensions", ".windsurf/extensions", ".vscode-oss/extensions", ".trae/extensions", ".trae-cn/extensions"];

/** 某个编辑器扩展是否装在任一编辑器里（扩展 ID 大小写不敏感） */
export function hasExtension(id: string, env: AgentEnv): boolean {
  const prefix = `${id.toLowerCase()}-`;
  return EXTENSION_DIRS.some((dir) => {
    try {
      return fs.readdirSync(path.join(env.home, dir)).some((name) => name.toLowerCase().startsWith(prefix));
    } catch {
      return false;
    }
  });
}

/** 是否已安装（规则见文件头） */
export function isInstalled(tool: ToolSpec, env: AgentEnv): boolean {
  if (tool.installPaths?.some((p) => fs.existsSync(expandPath(p, env)))) {
    return true;
  }
  if (tool.extensionId && hasExtension(tool.extensionId, env)) return true;
  if (!tool.exe) return false;
  const exe = which(tool.exe, env.platform);
  if (!exe) return false;
  const out = versionOutput(exe, env.platform);
  return out !== undefined && (!tool.versionPattern || tool.versionPattern.test(out));
}

/**
 * npm 安装命令：与各 Agent 官方文档一致，`npm install -g <包名>` 装最新版、跑安装脚本。
 * 不固定版本、不加 --ignore-scripts：Claude Code / OpenCode 等靠 postinstall 安装平台二进制，加了装完无法启动；
 * 安装后的升级交给 Agent 自己（thcli 不关它们的自动更新）。
 */
export function installCommandOf(tool: ToolSpec): string[] | undefined {
  if (!tool.npm) return undefined;
  return ["npm", "install", "-g", tool.npm.pkg];
}

/**
 * 跑安装命令。子进程环境剔除名字含 API_KEY / AUTH_TOKEN / SECRET 的变量——
 * 第三方包的安装过程没有理由看到用户的密钥。
 */
export function runInstall(cmd: string[], platform: NodeJS.Platform = process.platform): boolean {
  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/API_KEY|AUTH_TOKEN|SECRET/i.test(k)),
  );
  const [bin, ...args] = cmd;
  const result = spawnSync(platform === "win32" ? `${bin}.cmd` : bin!, args, {
    stdio: "inherit",
    env: childEnv,
    shell: platform === "win32",
    timeout: 600_000,
  });
  return result.status === 0;
}

/** WorkBuddy 是否在运行：运行中写入会在它退出时被内存里的旧列表覆盖 */
export function isProcessRunning(name: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (platform === "win32") {
      const r = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${name}.exe`], { encoding: "utf8" });
      return r.stdout.toLowerCase().includes(`${name.toLowerCase()}.exe`);
    }
    return spawnSync("pgrep", ["-f", name], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}
