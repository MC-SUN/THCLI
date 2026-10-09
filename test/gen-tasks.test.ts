/**
 * +gen 本地任务记录的测试。全部写临时文件，不碰 ~/.thcli。
 *
 * 这份记录存在的意义是"钱花了能把结果找回来"，所以重点测：
 *   - 提交记录与后续状态更新能合并成一条
 *   - 文件里有坏行（写入中断）时其余任务仍然能列出来
 *   - 提示词截断、文件权限、文件过大时的压缩
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  findTask,
  forEachLimit,
  type GenTask,
  loadTasks,
  needsRefresh,
  recordState,
  recordSubmitted,
  scopeOf,
} from "../src/core/gen-tasks.js";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "thcli-tasks-")), "gen-tasks.jsonl");
}

const base = { model: "hy-video-v1.5", kind: "video" as const, profile: "default", site: "cn", area: "gz" };

describe("本地任务记录", () => {
  it("提交记录与状态更新合并成一条，最新状态覆盖旧状态", () => {
    const file = tmpFile();
    recordSubmitted({ ...base, taskId: "t1", prompt: "小狗奔跑", createdAt: "2026-10-02T08:00:00.000Z" }, file);
    recordState("t1", "running", new Date("2026-10-02T08:00:10Z"), undefined, file);
    recordState("t1", "succeeded", new Date("2026-10-02T08:01:20Z"), ["/out/a.mp4"], file);
    const tasks = loadTasks(file);
    assert.equal(tasks.length, 1);
    assert.deepEqual(
      [tasks[0]!.state, tasks[0]!.model, tasks[0]!.prompt, tasks[0]!.updatedAt, tasks[0]!.saved],
      ["succeeded", "hy-video-v1.5", "小狗奔跑", "2026-10-02T08:01:20.000Z", ["/out/a.mp4"]],
    );
  });

  it("按提交时间倒序；findTask 按 ID 取", () => {
    const file = tmpFile();
    recordSubmitted({ ...base, taskId: "old", prompt: "a", createdAt: "2026-10-01T00:00:00.000Z" }, file);
    recordSubmitted({ ...base, taskId: "new", prompt: "b", createdAt: "2026-10-02T00:00:00.000Z" }, file);
    assert.deepEqual(
      loadTasks(file).map((x) => x.taskId),
      ["new", "old"],
    );
    assert.equal(findTask("old", file)?.prompt, "a");
    assert.equal(findTask("nope", file), undefined);
  });

  it("坏行与没有提交记录的状态行被跳过，不影响其它任务", () => {
    const file = tmpFile();
    recordSubmitted({ ...base, taskId: "ok", prompt: "p", createdAt: "2026-10-02T00:00:00.000Z" }, file);
    fs.appendFileSync(file, '{"taskId":"half\n');
    recordState("orphan", "succeeded", new Date(), undefined, file);
    assert.deepEqual(
      loadTasks(file).map((x) => x.taskId),
      ["ok"],
    );
  });

  it("提示词只留开头；文件 0600；文件不存在返回空", () => {
    const file = tmpFile();
    recordSubmitted({ ...base, taskId: "t", prompt: "字".repeat(200), createdAt: "2026-10-02T00:00:00.000Z" }, file);
    assert.equal(loadTasks(file)[0]!.prompt.length, 60);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(loadTasks(path.join(os.tmpdir(), "no-such-thcli-file.jsonl")), []);
  });

  it("状态与下载文件都没变时不追加；下载了新文件仍会记", () => {
    const file = tmpFile();
    recordSubmitted({ ...base, taskId: "t", prompt: "p", createdAt: "2026-10-02T00:00:00.000Z" }, file);
    const lines = (): number => fs.readFileSync(file, "utf8").trim().split("\n").length;
    recordState("t", "queued", new Date(), undefined, file);
    assert.equal(lines(), 1);
    recordState("t", "succeeded", new Date(), undefined, file);
    recordState("t", "succeeded", new Date(), undefined, file);
    assert.equal(lines(), 2);
    recordState("t", "succeeded", new Date(), ["/out/a.png"], file);
    recordState("t", "succeeded", new Date(), ["/out/a.png"], file);
    assert.equal(lines(), 3);
    assert.deepEqual(findTask("t", file)?.saved, ["/out/a.png"]);
  });

  it("文件过大时压缩成每任务一行，最新的任务与状态都保留", () => {
    const file = tmpFile();
    recordSubmitted({ ...base, taskId: "keep", prompt: "p", createdAt: "2026-10-02T00:00:00.000Z" }, file);
    for (let i = 0; i < 2100; i++) fs.appendFileSync(file, '{"taskId":"keep","state":"running"}\n');
    recordState("keep", "succeeded", new Date("2026-10-02T00:05:00Z"), undefined, file);
    // 下一次提交触发压缩
    recordSubmitted({ ...base, taskId: "next", prompt: "q", createdAt: "2026-10-02T01:00:00.000Z" }, file);
    assert.ok(fs.readFileSync(file, "utf8").split("\n").length < 10);
    assert.deepEqual(
      loadTasks(file).map((x) => [x.taskId, x.state]),
      [
        ["next", "queued"],
        ["keep", "succeeded"],
      ],
    );
  });

  it("scopeOf：没显式给 --profile/--site 时沿用提交时的，显式给了以命令行为准", () => {
    const task = { ...base, profile: "userA", site: "intl" } as GenTask;
    assert.deepEqual(scopeOf(task, {}), { profile: "userA", site: "intl" });
    assert.deepEqual(scopeOf(task, { profile: "userB" }), { profile: "userB", site: "intl" });
    assert.deepEqual(scopeOf(task, { profile: "userB", site: "cn" }), { profile: "userB", site: "cn" });
  });

  it("needsRefresh：终态与超过 24 小时的任务不刷新", () => {
    const now = new Date("2026-10-02T12:00:00Z");
    const at = (createdAt: string, state: GenTask["state"]): GenTask => ({ ...base, createdAt, state }) as GenTask;
    assert.equal(needsRefresh(at("2026-10-02T11:00:00Z", "running"), now), true);
    assert.equal(needsRefresh(at("2026-10-02T11:00:00Z", "succeeded"), now), false);
    assert.equal(needsRefresh(at("2026-10-02T11:00:00Z", "failed"), now), false);
    assert.equal(needsRefresh(at("2026-09-30T11:00:00Z", "queued"), now), false);
  });

  it("forEachLimit：全部执行，且同时进行的不超过上限", async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await forEachLimit(Array.from({ length: 20 }, (_, i) => i), 4, async (i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      done.push(i);
      running--;
    });
    assert.equal(done.length, 20);
    assert.equal(peak, 4);
  });
});
