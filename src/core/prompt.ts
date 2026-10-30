/**
 * 写操作/计费操作前的二次确认。
 */
import readline from "node:readline";

import { t } from "./i18n.js";

/**
 * 二次确认。--yes 直接放行；非交互环境（管道/脚本）没给 --yes 一律拒绝执行，
 * 不能默默当成"同意"。
 *
 * defaultYes：直接回车算同意（提示 [Y/n]），只用于"不做反而不完整"的步骤（如安装所选 Agent）；
 * 写云端、花钱、覆盖配置的确认一律默认否。
 */
export async function confirm(prompt: string, yes?: boolean, defaultYes = false): Promise<boolean> {
  if (yes) {
    return true;
  }
  if (!process.stdin.isTTY) {
    console.log(t("prompt.nonInteractive"));
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${prompt}${t(defaultYes ? "confirm.suffixDefaultYes" : "confirm.suffix")}`, resolve);
    });
    const normalized = answer.trim().toLowerCase();
    if (!normalized) return defaultYes;
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

/**
 * 问一行输入。非交互环境返回 undefined（调用方据此报错或走默认），
 * 不在管道里卡住等输入。
 *
 * hidden 用于输入 API Key：不回显键入内容，避免明文留在终端回滚与录屏里。
 */
export async function ask(prompt: string, hidden = false): Promise<string | undefined> {
  if (!process.stdin.isTTY) {
    return undefined;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    // readline 没有官方的密码模式：提示语照常输出，之后的回显一律吞掉
    const iface = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let promptShown = false;
    iface._writeToOutput = (s: string): void => {
      if (!promptShown) {
        iface.output.write(s);
        promptShown = true;
      } else if (s.includes("\n")) {
        iface.output.write("\n");
      }
    };
  }
  try {
    return await new Promise<string>((resolve) => rl.question(prompt, resolve));
  } finally {
    rl.close();
  }
}
