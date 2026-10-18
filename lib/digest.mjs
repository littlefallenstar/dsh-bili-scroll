/**
 * 一轮的「总结」——发给使用者看的那封信（纯函数，方便单测）。
 *
 * 2026-10-18 使用者第四版口径（拿他最喜欢的那封旧日报当模板，逐字对着改）：
 *   · 标题要**显眼** ⇒ `## B站日报 · 2026-10-18（周日）`（h2，邮件里是一行大字）
 *   · **各字段必须分行** ⇒ 每条下面是一串项目符号（UP / 链接 / 播放量 / 时长 / 评分 /
 *     推荐 / 为什么值得 / 我的一句话），不能像上一版那样挤成一段；
 *   · 「为什么值得」**80~120 字**（上一版写到两三百字，太长）；
 *   · 每条都要有「我的一句话」；
 *   · 末尾「总结」一段。
 * 仍不带笔记正文（想看全文去面板「今日」点「深挖」，那会单发一封）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim()

/** 「为什么值得/为什么不推荐」压到 80~120 字左右：超过就截到句号，别硬切在半句 */
export function clampWhy(text, max = 130) {
  const s = oneLine(text)
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const dot = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('！'))
  return dot > 60 ? cut.slice(0, dot + 1) : cut.replace(/[，、;；]?$/, '') + '…'
}

/** `2026-10-18` → `2026-10-18（周日）`；解不出就原样返回 */
export function dateLabel(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''))
  if (!m) return String(date || '')
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return `${date}（${WEEK[d.getUTCDay()]}）`
}

const clockOf = (hm) => (hm ? `${String(hm).slice(0, 2)}:${String(hm).slice(2, 4)}` : '')

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d]/g, ''))
  return Number.isFinite(n) && n > 0 ? n.toLocaleString('en-US') : ''
}

const isPick = (it) => String(it?.verdict || 'pick') !== 'reject'

export function renderDigest({ date, items = [], hm = '', keywords = [], limit = 0, note = '' }) {
  const picks = items.filter(isPick).sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
  const rejects = items.filter((it) => !isPick(it)).sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
  const all = [...picks, ...rejects]
  const clock = clockOf(hm)
  const kws = (Array.isArray(keywords) ? keywords : String(keywords || '').split(/[,，、\n]/))
    .map((s) => String(s || '').trim()).filter(Boolean)
  const cap = Number(limit) > 0 ? Number(limit) : all.length

  const parts = [`## B站日报 · ${dateLabel(date)}`, '']

  const lead = [clock ? `${clock} 跑的一轮` : '这一轮',
    kws.length ? `关键词：${kws.join('、')}` : '',
    `上限 ${cap} 条，这轮看了 ${all.length} 条：${picks.length} 推荐 / ${rejects.length} 不推荐`]
    .filter(Boolean).join('｜')
  parts.push(`> ${lead}`, '')

  const noteText = oneLine(note)
    || '说明：每条都读了字幕原文；本地转写关闭，没字幕的没硬凑。本轮没有发评论，也没有回复任何人。'
  parts.push(`> ${noteText}`, '')

  all.forEach((it, i) => {
    const pick = isPick(it)
    parts.push(`## ${i + 1}. ${it.title || it.bvid}`, '')
    if (it.up) parts.push(`- **UP**：${it.up}`)
    parts.push(`- **链接**：https://www.bilibili.com/video/${it.bvid}`)
    const view = num(it.view)
    if (view) parts.push(`- **播放量**：${view}`)
    if (it.duration) parts.push(`- **时长**：${it.duration}`)
    if (it.score !== undefined && it.score !== null && it.score !== '') parts.push(`- **评分**：${it.score}`)
    parts.push(`- **推荐**：${pick ? '✅ 值得看' : '❌ 不值得看'}`)
    const why = clampWhy(it.why || it.reason)
    if (why) parts.push(`- **${pick ? '为什么值得' : '为什么不推荐'}**：${why}`)
    // ⭐ 使用者点名要的一条：**每条下面都要有「我的一句话」**（缺失就留个短句，别整行消失）
    parts.push(`- **我的一句话**：${oneLine(it.mine) || (pick ? '这条先看，别拖。' : '这条可以跳过。')}`)
    parts.push('')
  })

  // ── 总结 ──────────────────────────────────────────────
  parts.push('## 总结', '')
  if (all.length === 0) {
    parts.push('这一轮一条都没看成（搜不到 / 都拿不到字幕），没有可推荐的。')
  } else if (picks.length === 0) {
    parts.push(`这轮看了 ${all.length} 条，**没有一条值得看**；` +
      '不是搜错了，是这轮确实没内容。下一轮换关键词再试。')
  } else {
    const top = picks[0]
    const first = clampWhy(top.why || top.reason, 80).split(/[。；]/)[0]
    parts.push(`这轮看了 ${all.length} 条，值得看的有 **${picks.length} 条**。`
      + `最该先看**第 1 条《${top.title || top.bvid}》**${top.score ? `（评分 ${top.score}）` : ''}`
      + `${first ? '：' + first + '。' : '。'}`)
    if (picks.length > 1) {
      parts.push('')
      parts.push('其余值得看的：' + picks.slice(1)
        .map((x, i) => `${i + 2}.《${x.title || x.bvid}》${x.score ? `（${x.score}）` : ''}`)
        .join('；') + '。')
    }
    if (rejects.length) {
      parts.push('')
      parts.push(`不推荐的 ${rejects.length} 条也列在上面了，理由都写在每条下面，不用再看。`)
    }
  }
  parts.push('')

  parts.push('---', '', '_想看某条的详细笔记：打开「刷B站」面板 → 今日 → 点那条的「深挖」，会单独发一封。_')
  return parts.join('\n')
}

/** 写盘（产物目录是 `<家>/out/<日期>/round-<HHmm>.md`） */
export function writeDigest({ outDir, date, items, hm = '', keywords = [], limit = 0, note = '' }) {
  const dir = join(outDir, date)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `round-${hm || 'latest'}.md`)
  const text = renderDigest({ date, items, hm, keywords, limit, note })
  writeFileSync(file, text, 'utf8')
  return { file, text }
}
