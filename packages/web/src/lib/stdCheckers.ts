/** Chinese descriptions of the standard testlib checkers (the files carry English ones). */
const ZH: Record<string, string> = {
  acmp: '比较两个 double，最大绝对误差 1.5e-6',
  caseicmp: '单个 int64 比较，支持多测试用例（Case #x）',
  casencmp: '多个 int64 比较，支持多测试用例（Case #x）',
  casewcmp: '单词序列比较，支持多测试用例（Case #x）',
  dcmp: '比较两个 double，最大绝对或相对误差 1e-6',
  fcmp: '逐行完全比较文件',
  hcmp: '比较两个有符号大整数',
  icmp: '比较两个有符号 int32',
  lcmp: '逐行比较单词序列',
  ncmp: '比较有序的有符号 int64 序列',
  nyesno: '多个 YES / NO（不区分大小写）',
  pointscmp: '带分数的检查器示例',
  pointsinfo: '输出 points_info 的检查器示例',
  rcmp: '比较两个 double，最大绝对误差 1.5e-6',
  rcmp4: '比较 double 序列，最大绝对或相对误差 1e-4',
  rcmp6: '比较 double 序列，最大绝对或相对误差 1e-6',
  rcmp9: '比较 double 序列，最大绝对或相对误差 1e-9',
  rncmp: '比较 double 序列，最大绝对误差 1.5e-5',
  uncmp: '比较无序的有符号 int64 序列',
  wcmp: '比较单词序列',
  yesno: 'YES 或 NO（不区分大小写）',
};

export function stdCheckerDescription(ref: string, fallback: string | undefined, locale: string): string {
  const name = ref.replace(/^std:/, '');
  return (locale.startsWith('zh') ? ZH[name] : undefined) ?? fallback ?? '';
}
