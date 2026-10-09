/**
 * 个人版 TokenPlan 纯逻辑的测试：系列 ↔ ProductType、档位解析、状态文案、时间。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  consoleKeyUrl,
  consoleUrlOf,
  packageStatusKey,
  parseSeries,
  percentOf,
  productTypeOf,
  remainingDays,
  renewFlagKey,
  seriesOfProductType,
  tierOfInquiryKey,
} from "../src/core/personal-plan.js";
import { assertRfc3339, toOffsetIso, utcRangeEndingAt } from "../src/core/time.js";

describe("系列与 ProductType", () => {
  it("common ↔ personal、hy ↔ personal-hunyuan，空值按 personal", () => {
    assert.equal(productTypeOf("common"), "personal");
    assert.equal(productTypeOf("hy"), "personal-hunyuan");
    assert.equal(seriesOfProductType("personal-hunyuan"), "hy");
    assert.equal(seriesOfProductType(""), "common");
    assert.equal(seriesOfProductType("other"), undefined);
  });

  it("parseSeries 大小写不敏感，非法值返回 undefined", () => {
    assert.equal(parseSeries(" HY "), "hy");
    assert.equal(parseSeries("pro"), undefined);
    assert.equal(parseSeries(undefined), undefined);
  });
});

describe("档位", () => {
  it("从 PrepayInquiryKey 末段取档位，认不出的原样返回", () => {
    assert.equal(tierOfInquiryKey("sv_lmp_tokenplan_eh_pro"), "pro");
    assert.equal(tierOfInquiryKey("sv_lmp_tokenplan_hy_lite"), "lite");
    assert.equal(tierOfInquiryKey("weird_plan"), "weird_plan");
    assert.equal(tierOfInquiryKey(undefined), "");
  });
});

describe("状态与续费文案", () => {
  it("PackageStatus 英文枚举映射到文案键", () => {
    assert.equal(packageStatusKey("ACTIVE"), "personal.status.active");
    assert.equal(packageStatusKey("unpurchased"), "personal.status.unpurchased");
    assert.equal(packageStatusKey("EXPIRED"), "personal.status.expired");
    // 认不出的原样回显，不猜含义
    assert.equal(packageStatusKey("FROZEN"), "FROZEN");
    assert.equal(packageStatusKey(undefined), "personal.status.unknown");
  });

  it("AutoRenewFlag 0/1/2 映射到续费文案键", () => {
    assert.equal(renewFlagKey(1), "personal.renew.auto");
    assert.equal(renewFlagKey(0), "personal.renew.manual");
    assert.equal(renewFlagKey(2), "personal.renew.never");
    assert.equal(renewFlagKey(9), "personal.renew.unknown");
  });
});

describe("时间", () => {
  it("过期时间按东八区解析，不受运行机器时区影响", () => {
    const now = Date.parse("2026-10-01T00:00:00+08:00");
    assert.equal(remainingDays("2026-10-31 00:00:00", now), 30);
    assert.equal(remainingDays("2026-09-30 00:00:00", now), -1);
    assert.equal(remainingDays("not a time", now), undefined);
  });

  it("percentOf 分母为 0 返回 undefined", () => {
    assert.equal(percentOf(25, 100), 25);
    assert.equal(percentOf(1, 0), undefined);
  });

  it("调用明细只给 --to 时，窗口对齐到终点而不是现在", () => {
    // 只给 --to 时若按"现在 −24h"算 From，会得到 From > To 的空窗口；这里固定以 --to 为终点
    const r = utcRangeEndingAt("2026-10-03T12:00:00+08:00", 24 * 60);
    assert.equal(r.end, "2026-10-03T04:00:00Z");
    assert.equal(r.start, "2026-10-02T04:00:00Z");
  });

  it("assertRfc3339 要求带时区", () => {
    assert.doesNotThrow(() => assertRfc3339("2026-10-03T12:00:00+08:00", "--from"));
    assert.throws(() => assertRfc3339("2026-10-03T12:00:00", "--from"));
  });

  it("toOffsetIso 转成带偏移的 ISO8601，非法值报错", () => {
    // 监控接口收带偏移的写法，与管控面那套 Z 结尾的 UTC 不通用
    assert.match(toOffsetIso("2026-10-03T12:00:00Z"), /^2026-10-03T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/);
    assert.throws(() => toOffsetIso("not-a-time"));
  });
});

describe("控制台链接", () => {
  it("按系列与站点拼路径", () => {
    assert.equal(consoleUrlOf("hy", "cn"), "https://console.cloud.tencent.com/tokenhub/tokenplan/hy");
    assert.equal(consoleUrlOf("common", "intl"), "https://console.tencentcloud.com/tokenhub/tokenplan/common");
  });

  it("Key 页在套餐路径下追加 /api-key", () => {
    assert.equal(consoleKeyUrl("common", "cn"), "https://console.cloud.tencent.com/tokenhub/tokenplan/common/api-key");
  });
});
