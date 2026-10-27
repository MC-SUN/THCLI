/**
 * +gen 命令层：
 *   - 接口字段 flag（--dry-run 跑真实 CLI 进程）：flag 是按 argv 里的接口 ID 动态挂载的，注册表单测覆盖不到
 *     「flag 挂载 → commander 解析 → 本地文件编码 → 合并 → 校验」这条链路
 *   - help 写法改写：末位 help → --help；+gen help <子命令|接口> → +gen <子命令|接口> --help
 * 本地任务记录见 tasks.test.ts。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { normalizeHelpArg } from "../../src/util/help-alias.js";
import { expandHome } from "../../src/util/expand-home.js";

const CLI = path.join(process.cwd(), "dist", "main.cjs");

function run(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync("node", [CLI, "--json", "+gen", ...args, "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, THCLI_LANG: "en" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

function body(args: string[]): Record<string, unknown> {
  const { out, code } = run(args);
  assert.equal(code, 0, out);
  return (JSON.parse(out) as { Body: Record<string, unknown> }).Body;
}

describe("+gen 接口字段 flag（--dry-run）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thcli-gen-"));
  const png = path.join(dir, "a.png");
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  it("flag 名即字段名：--prompt --size --sequential-image-generation 直接进请求体", () => {
    const b = body(["wand/si-image/generation", "--model", "seedream-image-v5.0-lite", "--prompt", "cat", "--size", "2K", "--sequential-image-generation", "auto", "--watermark", "true"]);
    assert.deepEqual(b, { model: "seedream-image-v5.0-lite", prompt: "cat", size: "2K", sequential_image_generation: "auto", watermark: true });
  });

  it("数组 / 对象传 JSON；本地图片按字段规则编码（dataUrl / 裸 Base64）", () => {
    const b = body(["wand/si-image/generation", "--model", "seedream-image-v5.0-pro", "--prompt", "cat", "--images", `["https://x/a.jpg","${png}"]`, "--optimize-prompt-options", '{"mode":"fast"}']);
    const images = b["images"] as string[];
    assert.equal(images[0], "https://x/a.jpg");
    assert.match(images[1]!, /^data:image\/png;base64,/);
    assert.deepEqual(b["optimize_prompt_options"], { mode: "fast" });

    const k = body(["wand/kling/image-to-video", "--model", "kling-video-v3", "--contents", `[{"type":"first_frame","url":"${png}"}]`]);
    const url = (k["contents"] as Array<{ url: string }>)[0]!.url;
    assert.ok(!url.startsWith("data:") && url.length > 0, "Kling 收裸 Base64");
  });

  it("单接口模型可省略 --model；--param 补充未收录字段（= 字符串、:= JSON）", () => {
    const b = body(["wand/hunyuan-image/v3-generation", "--prompt", "cat", "--param", "new_field:=1", "--param", "tag=1"]);
    assert.deepEqual(b, { model: "hy-image-v3", prompt: "cat", new_field: 1, tag: "1" });
  });

  it("覆盖关系：接口参数 < --param < --body；对象逐层合并", () => {
    const b = body([
      "wand/si-image/generation", "--model", "seedream-image-v5.0-pro", "--prompt", "flag", "--size", "2K",
      "--optimize-prompt-options", '{"mode":"standard"}',
      "--param", "prompt=param", "--param", "size=1K", "--param", "optimize_prompt_options.mode=fast",
      "--body", '{"prompt":"body"}',
    ]);
    assert.deepEqual(b, { model: "seedream-image-v5.0-pro", prompt: "body", size: "1K", optimize_prompt_options: { mode: "fast" } });
  });

  it("model 可由 --param / --body 指定，以最终请求体为准做接口白名单校验", () => {
    assert.equal(body(["wand/si-image/generation", "--prompt", "x", "--param", "model=seedream-image-v5.0-lite"])["model"], "seedream-image-v5.0-lite");
    assert.equal(
      body(["wand/si-image/generation", "--model", "seedream-image-v5.0-pro", "--prompt", "x", "--body", '{"model":"seedream-image-v5.0-flash"}'])["model"],
      "seedream-image-v5.0-flash",
    );
    const { out, code } = run(["wand/si-image/generation", "--model", "seedream-image-v5.0-pro", "--prompt", "x", "--body", '{"model":"kling-video-v3"}']);
    assert.notEqual(code, 0);
    assert.match(out, /kling-video-v3/);
  });

  it("其它接口的字段 / 已删除的公共参数：commander 直接报未知选项", () => {
    for (const flag of ["--aspect-ratio", "--ratio", "--duration", "--input"]) {
      const { out, code } = run(["wand/si-image/generation", "--model", "seedream-image-v5.0-pro", "--prompt", "x", flag, "1"]);
      assert.notEqual(code, 0, flag);
      assert.match(out, /unknown option/, flag);
    }
  });

  it("本地校验：只收 URL 的字段拒本地文件；模型不支持的字段报错；必填缺失报错", () => {
    assert.match(run(["wand/vega-videos/tasks", "--content", `[{"type":"image_url","image_url":{"url":"${png}"}}]`]).out, /only accepts public URLs/);
    assert.match(run(["wand/si-image/generation", "--model", "seedream-image-v5.0-pro", "--prompt", "x", "--tools", '{"type":"web_search"}']).out, /only supported by seedream-image-v5.0-lite/);
    assert.match(run(["wand/minimax-tts/sync_tts", "--model", "minimax-speech-2.8-hd", "--text", "hi"]).out, /--voice-setting is required/);
  });
});

const N = (...args: string[]): string[] => normalizeHelpArg(["node", "thcli", ...args]).slice(2);

describe("normalizeHelpArg", () => {
  it("末位 help 改写成 --help；前一项是选项名时不改", () => {
    assert.deepEqual(N("+gen", "status", "help"), ["+gen", "status", "--help"]);
    assert.deepEqual(N("+gen", "help"), ["+gen", "--help"]);
    assert.deepEqual(N("agent", "install", "--name", "help"), ["agent", "install", "--name", "help"]);
  });

  it("+gen help <子命令|接口ID> 改写成 +gen <子命令|接口ID> --help", () => {
    assert.deepEqual(N("+gen", "help", "status"), ["+gen", "status", "--help"]);
    assert.deepEqual(N("+gen", "help", "tasks"), ["+gen", "tasks", "--help"]);
    assert.deepEqual(N("+gen", "help", "resource", "kling-voice"), ["+gen", "resource", "kling-voice", "--help"]);
    assert.deepEqual(N("--lang", "en", "+gen", "help", "wand/vidu/text-to-video"), ["--lang", "en", "+gen", "wand/vidu/text-to-video", "--help"]);
  });

  it("+gen 接口调用里的 help 值不改（如 --prompt help）", () => {
    assert.deepEqual(N("+gen", "wand/si-image/generation", "--prompt", "help"), ["+gen", "wand/si-image/generation", "--prompt", "help"]);
  });
});

describe("~ 展开", () => {
  it("~/ 与裸 ~ 展开到主目录；~其它用户名明确报错；普通路径原样", () => {
    const home = os.homedir();
    assert.equal(expandHome("~/thcli-out"), path.join(home, "thcli-out"));
    assert.equal(expandHome("~"), home);
    assert.equal(expandHome("./out"), "./out");
    assert.equal(expandHome("/abs/out"), "/abs/out");
    // ~user 形式不静默展开（曾会把 ./~user 建进当前目录或错拼到主目录下）
    assert.throws(() => expandHome("~root/out"), /cross-platform|absolute path/);
  });
});
