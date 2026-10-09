/**
 * +chat 路由矩阵：--plan × --responses × --anthropic × --search 各组合落到哪个 URL、用哪种 body、搜索怎么写。
 * 显式给 --api-key，不读本地 keystore；只解析，不发请求。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveRequest } from "../src/commands/chat.js";

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
