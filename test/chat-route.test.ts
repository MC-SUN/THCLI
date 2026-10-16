/**
 * +chat 路由矩阵：--plan × --responses × --anthropic × --search 各组合落到哪个 URL、用哪种 body、搜索怎么写。
 * 另含多模态内容构造（--input 本地图 / 视频 / 文本的编码方式）。
 * 显式给 --api-key，不读本地 keystore；只解析，不发请求。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { resolveRequest } from "../src/commands/chat.js";
import { buildChatContent, classifyInput } from "../src/core/chat-content.js";

const g = { site: "cn" };
const key = { apiKey: "sk-test-1234567890" };

function route(opts: Record<string, unknown>) {
  const r = resolveRequest({ ...key, ...opts }, g);
  return { path: new URL(r.url).pathname, host: new URL(r.url).host, payload: r.payloadChannel, search: r.searchForm };
}

describe("+chat 路由矩阵", () => {
  it("按量：默认 chat；--responses 走 /v1/responses；--anthropic 走 /v1/messages", () => {
    assert.deepEqual(route({}), { path: "/v1/chat/completions", host: "tokenhub.tencentmaas.com", payload: "chat", search: "none" });
    assert.deepEqual(route({ responses: true }), { path: "/v1/responses", host: "tokenhub.tencentmaas.com", payload: "responses", search: "none" });
    assert.equal(route({ anthropic: true }).path, "/v1/messages");
    assert.equal(route({ anthropic: true }).payload, "anthropic");
  });

  it("--search 按协议选写法：chat 用 web_search_options，responses 用 tools，anthropic 不写", () => {
    assert.equal(route({ search: true }).search, "chat_options");
    assert.equal(route({ search: true, responses: true }).search, "responses");
    assert.equal(route({ search: true, anthropic: true }).search, "none");
  });

  it("--plan 锁定套餐通道：--responses / --search 不改 URL，只改 body 形状与搜索写法", () => {
    assert.deepEqual(route({ plan: "tp-ep" }), { path: "/plan/v3/chat/completions", host: "tokenhub.tencentmaas.com", payload: "chat", search: "none" });
    const r = route({ plan: "tp-ep", responses: true, search: true });
    assert.equal(r.path, "/plan/v3/chat/completions");
    assert.equal(r.payload, "responses");
    assert.equal(r.search, "responses");
    assert.equal(route({ plan: "tp-ep", search: true }).search, "chat_options");
  });

  it("个人版与企业版同一套网关；--plan + --anthropic 走 /plan/anthropic/v1/messages", () => {
    assert.equal(route({ plan: "tp" }).host, "tokenhub.tencentmaas.com");
    assert.equal(route({ plan: "tp", anthropic: true }).path, "/plan/anthropic/v1/messages");
    assert.equal(route({ plan: "tp-ep", anthropic: true }).path, "/plan/anthropic/v1/messages");
  });

  it("非法 --plan 报错", () => {
    assert.throws(() => resolveRequest({ ...key, plan: "th" }, g));
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
