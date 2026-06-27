export function nowInChinaIso() {
  const now = new Date();
  const chinaTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return `${chinaTime.toISOString().slice(0, 19)}+08:00`;
}
