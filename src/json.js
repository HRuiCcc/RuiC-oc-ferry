// WorkBuddy 的配置可能是别的 Windows 程序写出来的，带不带 BOM 都要能读。
export function parseJson(text) {
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}
