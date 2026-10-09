/**
 * +gen 注册表与 +chat 多模态内容构造的测试。
 *
 * 生成类接口每家厂商的字段都不同，这里把"文档示例的请求体 / 响应体"当作契约：
 * 构造出的请求体要与文档示例同构，文档示例的响应要能被正确归一化。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildChatContent, classifyInput } from "../src/core/chat-content.js";
import { deepMerge } from "../src/core/config.js";
import { FAMILIES, familyOf, normalizeState, parseParams } from "../src/core/media-registry.js";

const req = (model: string, extra: Record<string, unknown> = {}) => ({ model, prompt: "p", images: [] as string[], ...extra });

describe("注册表完整性", () => {
  it("模型 ID 全局唯一，异步族都有 taskIdOf 与 query", () => {
    const seen = new Set<string>();
    for (const f of FAMILIES) {
      for (const m of f.models) {
        assert.ok(!seen.has(m), `重复的模型 ${m}`);
        seen.add(m);
      }
      if (!f.sync) assert.ok(f.taskIdOf && f.query, f.id);
    }
  });

  it("每个族都声明了支持的选项与官方调用指南", () => {
    const known = ["size", "ratio", "resolution", "duration", "negativePrompt", "audio"];
    for (const f of FAMILIES) {
      assert.match(f.doc, /^https:\/\/cloud\.tencent\.com\/document\/product\/1823\/\d+$/, f.id);
      for (const o of f.options) assert.ok(known.includes(o), `${f.id}: ${o}`);
    }
    // 生图不该声明视频才有的选项
    assert.ok(!familyOf("hy-image-v3")!.options.includes("duration"));
    assert.ok(familyOf("yt-video-humanactor")!.options.includes("audio"));
  });

  it("familyOf 按类别过滤", () => {
    assert.equal(familyOf("hy-video-v1.5", "video")?.id, "hy-video");
    assert.equal(familyOf("hy-video-v1.5", "image"), undefined);
  });
});

describe("请求构造与文档示例同构", () => {
  it("混元生视频：图生时用 image_url，且不带 aspect_ratio", () => {
    const f = familyOf("hy-video-v1.5")!;
    const s = f.submit(req("hy-video-v1.5", { images: ["https://x/a.jpg"], ratio: "16:9" }));
    assert.equal(s.path, "/v1/wand/hunyuan-video/generation");
    assert.deepEqual(s.body, { model: "hy-video-v1.5", prompt: "p", image_url: "https://x/a.jpg" });
  });

  it("Kling 视频：无图走 text-to-video，有图走 image-to-video 的 contents 数组", () => {
    const f = familyOf("kling-video-v3")!;
    assert.equal(f.submit(req("kling-video-v3")).path, "/v1/wand/kling/text-to-video");
    const s = f.submit(req("kling-video-v3", { images: ["u1", "u2"] }));
    assert.equal(s.path, "/v1/wand/kling/image-to-video");
    assert.deepEqual((s.body["contents"] as unknown[]).map((c) => (c as { type: string }).type), ["prompt", "first_frame", "last_frame"]);
  });

  it("Vidu 视频按图片张数选路由", () => {
    const f = familyOf("vidu-video-q2")!;
    assert.equal(f.submit(req("vidu-video-q2")).path, "/v1/wand/vidu/text-to-video");
    assert.equal(f.submit(req("vidu-video-q2", { images: ["a"] })).path, "/v1/wand/vidu/image-to-video");
    assert.equal(f.submit(req("vidu-video-q2", { images: ["a", "b"] })).path, "/v1/wand/vidu/start-end-to-video");
  });

  it("YT：人像驱动用扁平 image_url + audio_url；图生视频用 image:{url}", () => {
    const f = familyOf("yt-video-humanactor")!;
    assert.deepEqual(f.submit(req("yt-video-humanactor", { images: ["https://x/face.png"], audio: "https://x/a.wav" })).body, {
      model: "yt-video-humanactor",
      prompt: "p",
      image_url: "https://x/face.png",
      audio_url: "https://x/a.wav",
    });
    assert.deepEqual(f.submit(req("yt-video-2.0", { images: ["https://x/i.png"] })).body, { model: "yt-video-2.0", prompt: "p", image: { url: "https://x/i.png" } });
  });

  it("混元 3D：提示词与图片互斥", () => {
    const f = familyOf("hy-3d-3.1")!;
    assert.deepEqual(f.submit(req("hy-3d-3.1")).body, { model: "hy-3d-3.1", prompt: "p" });
    assert.deepEqual(f.submit(req("hy-3d-3.1", { images: ["BASE64"] })).body, { model: "hy-3d-3.1", image_base64: "BASE64" });
  });

  it("Hy-Image-3.5 用 messages 协议：最后一条 user 消息里文本 + 图片", () => {
    const s = familyOf("hy-image-v3.5-preview")!.submit(req("hy-image-v3.5-preview", { images: ["data:image/png;base64,AA"] }));
    const msg = (s.body["messages"] as Array<{ role: string; content: Array<{ type: string }> }>)[0]!;
    assert.equal(msg.role, "user");
    assert.deepEqual(msg.content.map((c) => c.type), ["text", "image_url"]);
  });
});

describe("响应归一化（用文档示例响应）", () => {
  it("同步：Hy-Image-3.0 的 data[].url", () => {
    const r = familyOf("hy-image-v3")!.parse({ data: [{ url: "https://r/1.png" }] });
    assert.deepEqual([r.state, r.urls], ["succeeded", ["https://r/1.png"]]);
  });

  it("同步：Hy-Image-3.5 失败帧带 error", () => {
    const r = familyOf("hy-image-v3.5-preview")!.parse({ choices: [{ delta: {}, finish_reason: "error" }], error: { message: "input moderation rejected" } });
    assert.equal(r.state, "failed");
    assert.equal(r.error, "input moderation rejected");
  });

  it("PixVerse 的数字状态：1 成功 / 5 生成中 / 7 审核失败", () => {
    const f = familyOf("pixverse-video-v6.0")!;
    assert.equal(f.parse({ Resp: { status: 1, url: "u" } }).state, "succeeded");
    assert.equal(f.parse({ Resp: { status: 5 } }).state, "running");
    assert.equal(f.parse({ Resp: { status: 7 }, ErrMsg: "audit" }).state, "failed");
    assert.equal(f.taskIdOf!({ Resp: { video_id: "vid" } }), "vid");
  });

  it("Kling 视频查询：data 是数组，结果在 outputs[].url", () => {
    const r = familyOf("kling-video-v3")!.parse({ code: 0, data: [{ status: "succeeded", outputs: [{ url: "https://v.mp4" }] }] });
    assert.deepEqual([r.state, r.urls], ["succeeded", ["https://v.mp4"]]);
  });

  it("MiniMax H3：task.status / task.content.url", () => {
    const r = familyOf("minimax-video-h3")!.parse({ task: { status: "succeeded", content: { url: "https://m.mp4" } } });
    assert.deepEqual([r.state, r.urls], ["succeeded", ["https://m.mp4"]]);
  });

  it("混元 3D：模型文件 + 预览图", () => {
    const r = familyOf("hy-3d-3.1")!.parse({
      status: "completed",
      data: [{ type: "glb", url: "https://a.glb", preview_image_url: "https://a.png" }],
    });
    assert.deepEqual([r.state, r.urls, r.extraUrls], ["succeeded", ["https://a.glb"], ["https://a.png"]]);
  });

  it("状态枚举归一；未知值按进行中处理（宁可多轮询，不误报）", () => {
    for (const [raw, want] of [["succeed", "succeeded"], ["Success", "succeeded"], ["completed", "succeeded"], ["queueing", "queued"], ["in_progress", "running"], ["cancelled", "failed"], ["weird", "running"]] as const) {
      assert.equal(normalizeState(raw), want, raw);
    }
  });
});

describe("--param / --body", () => {
  it("值按 JSON 解析，键支持点路径", () => {
    assert.deepEqual(parseParams(["n=2", "style=anime", "settings.audio=native", "flag=true"]), {
      n: 2,
      style: "anime",
      settings: { audio: "native" },
      flag: true,
    });
  });

  it("缺等号报错", () => {
    assert.throws(() => parseParams(["oops"]));
  });

  it("deepMerge 深合并对象、整体替换数组、override 为 undefined 时保留 base", () => {
    assert.deepEqual(deepMerge({ a: 1 }, undefined), { a: 1 });
    assert.deepEqual(deepMerge({ a: { x: 1, y: 2 }, l: [1] }, { a: { y: 3 }, l: [2] }), { a: { x: 1, y: 3 }, l: [2] });
  });
});

describe("+chat 多模态内容", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thcli-chat-"));
  const png = path.join(dir, "a.png");
  const mp4 = path.join(dir, "v.mp4");
  const txt = path.join(dir, "n.md");
  fs.writeFileSync(png, Buffer.from([0x89, 0x50]));
  fs.writeFileSync(mp4, Buffer.from([0, 0, 0, 0x20]));
  fs.writeFileSync(txt, "hello");

  it("URL 原样透传，按扩展名判断图片 / 视频，可用前缀强制", () => {
    assert.deepEqual(classifyInput("https://x/a.mp4"), { kind: "video", origin: "url", ref: "https://x/a.mp4", mime: "video/mp4" });
    assert.equal(classifyInput("https://cdn/abc").kind, "image");
    assert.equal(classifyInput("video:https://cdn/abc").kind, "video");
  });

  it("chat：本地图 → data URL 的 image_url 块，视频 → video_url 块，问题文本在最后", () => {
    const { content } = buildChatContent("chat", "描述", [png, mp4]);
    const parts = content as Array<Record<string, any>>;
    assert.deepEqual(parts.map((p) => p["type"]), ["image_url", "video_url", "text"]);
    assert.match(parts[0]!["image_url"]["url"], /^data:image\/png;base64,/);
    assert.match(parts[1]!["video_url"]["url"], /^data:video\/mp4;base64,/);
  });

  it("本地视频给出「部分模型只收 URL」的提示", () => {
    assert.equal(buildChatContent("chat", "x", [mp4]).warnings.length, 1);
  });

  it("responses：图片用扁平的 input_image，文本用 input_text", () => {
    const parts = buildChatContent("responses", "q", ["https://x/a.png"]).content as Array<Record<string, unknown>>;
    assert.deepEqual(parts, [
      { type: "input_image", image_url: "https://x/a.png" },
      { type: "input_text", text: "q" },
    ]);
  });

  it("视频三种协议各有块结构；Responses 因模型而异，附带提示", () => {
    const an = buildChatContent("anthropic", "q", ["https://x/v.mp4", mp4]).content as Array<Record<string, any>>;
    assert.deepEqual(an[0], { type: "video", source: { type: "url", url: "https://x/v.mp4" } });
    assert.deepEqual([an[1]!["type"], an[1]!["source"]["type"], an[1]!["source"]["media_type"]], ["video", "base64", "video/mp4"]);

    const rs = buildChatContent("responses", "q", ["https://x/v.mp4"]);
    assert.deepEqual((rs.content as unknown[])[0], { type: "input_video", video_url: "https://x/v.mp4" });
    assert.equal(rs.warnings.length, 1);
    assert.equal(buildChatContent("chat", "q", ["https://x/v.mp4"]).warnings.length, 0);
  });

  it("anthropic：本地图片用 source.type=base64，URL 用 source.type=url", () => {
    const local = buildChatContent("anthropic", undefined, [png]).content as Array<Record<string, any>>;
    assert.equal(local[0]!["source"]["type"], "base64");
    const remote = buildChatContent("anthropic", undefined, ["https://x/a.png"]).content as Array<Record<string, any>>;
    assert.deepEqual(remote[0], { type: "image", source: { type: "url", url: "https://x/a.png" } });
  });

  it("只有文本文件时仍是纯字符串（与一期行为一致）", () => {
    const { content } = buildChatContent("chat", "总结", [txt]);
    assert.equal(typeof content, "string");
    assert.match(content as string, /hello/);
  });
});
