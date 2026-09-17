import type { Match } from './matcher'

/** 提示行的硬上限（字符）。超过即截断，防止提示本身变成噪音。 */
export const HINT_MAX_CHARS = 120

/**
 * 纯函数：把命中结果渲染成**一行**提示。
 *
 * 空匹配返回空字符串——调用方据此决定不注入（不要注入空行）。
 */
export function renderHint(matches: Match[], prefix: string): string {
  if (!matches.length) return ''
  const names = matches.map((m) => m.skill).join(', ')
  const line = `${prefix} 本轮可能适用：${names}`
  return line.length <= HINT_MAX_CHARS ? line : `${line.slice(0, HINT_MAX_CHARS - 1)}…`
}
