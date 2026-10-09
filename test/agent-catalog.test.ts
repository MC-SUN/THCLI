/**
 * 模型目录三级来源（api → doc → builtin）与文档表格解析的测试。
 *
 * 文档解析用的是官方页面的真实表格结构（表头 Model Name | Model ID、同格并列别名、
 * 备注里写"下线"），不发网络请求。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  builtinCatalog,
  capabilityOf,
  isAgentTextModel,
  parseModelTables,
  pickDocModels,
  resolveCatalog,
  sanitizeModelIds,
} from "../src/core/agent/catalog.js";
import { BUILTIN_MODELS } from "../src/core/agent/builtin-models.js";

/** 仿官方文档：个人版页上两张表（通用 / Hy） + 一张非模型表 */
const PERSONAL_PAGE = `
<table><tr><th>套餐</th><th>价格</th></tr><tr><td>Lite</td><td>39</td></tr></table>
<table>
  <tr><th>Model Name</th><th>Model ID</th><th>说明</th></tr>
  <tr><td>Auto</td><td>tc-code-latest</td><td>智能路由</td></tr>
  <tr><td>GLM-5.3</td><td>glm-5.3 glm-5-3</td><td>-</td></tr>
  <tr><td>GLM-5</td><td>glm-5 glm-5-0</td><td>将于2026年10月9日下线</td></tr>
  <tr><td>DeepSeek</td><td>deepseek/deepseek-flash</td><td>-</td></tr>
</table>
<table>
  <tr><th>Model Name</th><th>Model ID</th></tr>
  <tr><td>Hy3</td><td>hy3 hy3-preview</td></tr>
  <tr><td>Hy4 preview</td><td>hy4-preview</td></tr>
</table>`;

describe("文档表格解析", () => {
  it("只认带 Model ID 列的表，取每格第一个 ID，跳过公告下线的", () => {
    const tables = parseModelTables(PERSONAL_PAGE);
    assert.deepEqual(tables, [["tc-code-latest", "glm-5.3", "deepseek/deepseek-flash"], ["hy3", "hy4-preview"]]);
  });

  it("按首行 ID 区分同一页上的通用 / Hy 两张表", () => {
    assert.deepEqual(pickDocModels("tp-common", PERSONAL_PAGE), ["tc-code-latest", "glm-5.3", "deepseek/deepseek-flash"]);
    assert.deepEqual(pickDocModels("tp-hy", PERSONAL_PAGE), ["hy3", "hy4-preview"]);
  });

  it("模型列表页的表头写作 model（调用参数）也能识别；按量排除翻译与角色扮演", () => {
    const page = `<table><tr><th>模型名称</th><th>model（调用参数）</th></tr>
      <tr><td>Hy3</td><td>hy3</td></tr><tr><td>MT</td><td>hy-mt2-pro</td></tr><tr><td>Role</td><td>hy-role</td></tr></table>`;
    assert.deepEqual(pickDocModels("th", page), ["hy3"]);
  });
});

describe("三级回退", () => {
  it("api 有结果就用 api", async () => {
    const c = await resolveCatalog("th", "cn", async () => ({ models: ["a", "b"], detail: "X" }), async () => ["doc"]);
    assert.deepEqual([c.source, c.models], ["api", ["a", "b"]]);
  });

  it("api 抛错（未登录 / 无权限）退到文档", async () => {
    const c = await resolveCatalog(
      "tp-hy",
      "cn",
      async () => {
        throw new Error("AuthFailure");
      },
      async () => ["hy3"],
    );
    assert.deepEqual([c.source, c.models], ["doc", ["hy3"]]);
  });

  it("文档也拿不到退到内置快照", async () => {
    const c = await resolveCatalog("tp-hy", "cn", undefined, async () => undefined);
    assert.equal(c.source, "builtin");
    assert.deepEqual(c.models, [...BUILTIN_MODELS["tp-hy"]]);
  });

  it("国际站没有可解析的文档页，直接用快照", async () => {
    let docCalled = false;
    const c = await resolveCatalog("tp-ep", "intl", undefined, async () => {
      docCalled = true;
      return ["x"];
    });
    assert.equal(docCalled, false);
    assert.equal(c.source, "builtin");
  });

  it("api 返回的非法 ID 被白名单丢弃；全被丢弃视为这一级不可用", async () => {
    const c = await resolveCatalog("th", "cn", async () => ({ models: ['a"; rm -rf', "$(x)"], detail: "X" }), async () => ["ok"]);
    assert.equal(c.source, "doc");
  });
});

describe("白名单与默认模型", () => {
  it("sanitizeModelIds 去重并拒绝 shell / TOML 元字符", () => {
    assert.deepEqual(sanitizeModelIds(["a", "a", "b/c", "d e", 'x"', "", null]), ["a", "b/c"]);
  });


  it("内置快照每个目录都非空且全部通过白名单", () => {
    for (const key of Object.keys(BUILTIN_MODELS) as Array<keyof typeof BUILTIN_MODELS>) {
      const c = builtinCatalog(key);
      assert.ok(c.models.length > 0, key);
      assert.deepEqual(sanitizeModelIds(c.models), c.models, key);
    }
  });

  it("能力取自 Tags：视觉 / 多模态理解 → vision，深度思考 → reasoning", () => {
    assert.deepEqual(capabilityOf({ Tags: ["文本生成", "视觉理解", "深度思考"] }), { vision: true, reasoning: true });
    assert.deepEqual(capabilityOf({ Tags: ["文本生成"] }), { vision: false, reasoning: false });
  });

  it("文档兜底的名称过滤锚定前后缀：hy-role 排除，名字里碰巧含 role 的不误伤", () => {
    const page = `<table><tr><th>Model Name</th><th>Model ID</th></tr><tr><td>a</td><td>hy-role</td></tr><tr><td>b</td><td>controller-x</td></tr></table>`;
    assert.deepEqual(pickDocModels("th", page), ["controller-x"]);
  });

  it("按量模型过滤：只留在线的文本对话模型", () => {
    assert.equal(isAgentTextModel({ ModelType: "Text", Tags: ["文本生成"], Status: "online" }), true);
    assert.equal(isAgentTextModel({ ModelType: "Text", Tags: ["翻译"], Status: "online" }), false);
    assert.equal(isAgentTextModel({ ModelType: "Text", Tags: [], Status: "pre-offline" }), false);
    assert.equal(isAgentTextModel({ ModelType: "Vision", Tags: [], Status: "online" }), false);
  });
});
