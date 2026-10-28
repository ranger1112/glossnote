/** Tauri 命令失败时抛的是字符串，普通异常是 Error；界面上都当成一行文本显示。 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
