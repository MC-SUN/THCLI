/**
 * TOML 手术式编辑的单元测试。
 *
 * 重点是"不伤用户内容"与"不被注入"：Codex / Kimi 的配置文件里常有用户自己的
 * provider 和注释，我们只能动自己的键；Key 里一旦混进引号或换行，不转义就会
 * 让整个文件解析失败（工具启动即报错）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  escapeBasicString,
  joinLines,
  normalizeHeader,
  dropRootKey,
  dropSectionKey,
  readRootString,
  removeSections,
  splitLines,
  upsertRootKey,
  upsertSection,
} from "../src/core/agent/toml.js";

describe("upsertRootKey", () => {
  it("替换已有根键，不动其它行", () => {
    const out = upsertRootKey(["# c", 'model = "gpt-5"', "x = 1", "", "[a]", "k = 1"], "model", "glm-5.3");
    assert.deepEqual(out, ["# c", 'model = "glm-5.3"', "x = 1", "", "[a]", "k = 1"]);
  });

  it("新根键插在第一个表头之前（TOML 规定根键必须在表之前）", () => {
    const out = upsertRootKey(['model = "a"', "", "[a]", "k = 1"], "model_provider", "tokenhub");
    assert.ok(out.indexOf('model_provider = "tokenhub"') < out.indexOf("[a]"));
    // 保留根区与表头之间的空行
    assert.equal(out[out.indexOf("[a]") - 1], "");
  });

  it("段内同名键不算根键", () => {
    const out = upsertRootKey(["[a]", 'model = "inner"'], "model", "outer");
    assert.equal(out[0], 'model = "outer"');
    assert.ok(out.includes('model = "inner"'));
  });
});

describe("upsertSection", () => {
  it("新建段", () => {
    const out = upsertSection(["x = 1"], "[p.tokenhub]", { base_url: "https://a/v1", n: 3, on: true });
    assert.deepEqual(out, ["x = 1", "", "[p.tokenhub]", 'base_url = "https://a/v1"', "n = 3", "on = true"]);
  });

  it("更新已有段：替换我们的键、保留用户的键、补齐缺的键", () => {
    const lines = ["[p.tokenhub]", 'base_url = "old"', "user_key = 1", "", "[other]", "k = 2"];
    const out = upsertSection(lines, "[p.tokenhub]", { base_url: "new", wire_api: "responses" });
    // 新键接在段内最后一个键之后，段与下一个表头之间的空行保留
    assert.deepEqual(out, ["[p.tokenhub]", 'base_url = "new"', "user_key = 1", 'wire_api = "responses"', "", "[other]", "k = 2"]);
  });

  it("重复执行字节不变（幂等）", () => {
    const once = upsertSection(["a = 1"], "[s]", { k: "v" });
    assert.deepEqual(upsertSection(once, "[s]", { k: "v" }), once);
  });
});

describe("removeSections / normalizeHeader", () => {
  it("引号与不带引号的表头归一到同一个名字", () => {
    assert.equal(normalizeHeader('[models."glm-5.3"]'), "models.glm-5.3");
    assert.equal(normalizeHeader("[models.glm-5.3]"), "models.glm-5.3");
  });

  it("按归一化名字删整段，其它段不动", () => {
    const lines = ['[models."a"]', "x = 1", "[keep]", "y = 2", "[models.b]", "z = 3"];
    assert.deepEqual(removeSections(lines, new Set(["models.a", "models.b"])), ["[keep]", "y = 2"]);
  });
});

describe("转义与注入防护", () => {
  it("引号、反斜杠、换行全部转义", () => {
    assert.equal(escapeBasicString('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
  });

  it("恶意值写进段里仍是一行合法赋值", () => {
    const out = upsertSection([], "[p]", { api_key: 'x"\n[evil]\nk = "1' });
    assert.equal(out.filter((l) => l.trim() === "[evil]").length, 0);
    assert.equal(out.length, 2);
  });
});

describe("读写辅助", () => {
  it("readRootString 只读根区", () => {
    const text = joinLines(['model = "glm"', "[s]", 'model = "inner"']);
    assert.equal(readRootString(text, "model"), "glm");
  });

  it("splitLines 兼容 CRLF，joinLines 只留一个结尾换行", () => {
    assert.deepEqual(splitLines("a\r\nb"), ["a", "b"]);
    assert.equal(joinLines(["a", "", ""]), "a\n");
  });

  it("表头紧接段尾空行时，新键贴着表头写；空根区补一行再接表头", () => {
    let lines = splitLines('[p.x]\nold = "1"\n');
    lines = upsertSection(dropSectionKey(lines, "[p.x]", "old"), "[p.x]", { a: "b" });
    lines = upsertRootKey(lines, "m", "v");
    assert.equal(joinLines(lines), 'm = "v"\n\n[p.x]\na = "b"\n');
  });

  it("dropRootKey 只删根区的赋值行，段内同名键不动", () => {
    const lines = splitLines('a = 1\nk = 2\n\n[s]\nk = 3\n');
    assert.equal(joinLines(dropRootKey(lines, "k")), 'a = 1\n\n[s]\nk = 3\n');
  });

  it("dropSectionKey 只删指定段里的赋值行，段不存在原样返回", () => {
    const lines = splitLines('k = 0\n[s]\nk = 1\nx = 2\n[t]\nk = 3\n');
    assert.equal(joinLines(dropSectionKey(lines, "[s]", "k")), 'k = 0\n[s]\nx = 2\n[t]\nk = 3\n');
    assert.deepEqual(dropSectionKey(lines, "[none]", "k"), lines);
  });
});
