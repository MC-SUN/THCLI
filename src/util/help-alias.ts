/**
 * 让任意层级的 `thcli ... help` 等价于 `thcli ... --help`。
 *
 * commander 只在有子命令的层级自动提供 `help` 子命令；叶子命令（如 usage rank、
 * doctor error）收到的 `help` 会被当成多余的位置参数静默忽略，直接执行命令。
 * 为让全命令树的 help 行为一致，解析前统一把末位的 `help` 改写成 `--help`。
 */

/**
 * 把末位的 `help` 改写成 `--help`。
 * 前一项是选项名时不改写——避免误伤值恰好是 "help" 的选项（如 --name help）。
 */
export function normalizeHelpArg(argv: string[]): string[] {
  // +gen 自己带 action（接口 ID 是位置参数），commander 不会给它加隐式的 help 子命令，
  // `+gen help <子命令|接口ID> ...` 在这里改写成 `+gen <子命令|接口ID> ... --help`，与其他命令组的用法一致
  const gen = argv.indexOf("+gen");
  if (gen >= 0 && argv[gen + 1] === "help" && argv.length > gen + 2 && !argv[gen + 2]!.startsWith("-")) {
    return [...argv.slice(0, gen + 1), ...argv.slice(gen + 2), "--help"];
  }
  if (argv.length < 3 || argv[argv.length - 1] !== "help") {
    return argv;
  }
  const prev = argv[argv.length - 2];
  if (prev?.startsWith("-")) {
    return argv;
  }
  return [...argv.slice(0, -1), "--help"];
}
