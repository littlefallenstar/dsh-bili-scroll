/**
 * lib/today.mjs —— 「今日刷过的视频」那张表（结构化产物）
 * ============================================================================
 * 为什么要它（2026-10-18，使用者要的 ②③④）：
 *   · 日报是**给人看的散文**，界面拿它渲染列表得靠猜 ⇒ 必须有**机器可读**的一份；
 *   · 「不推荐的默认不进列表，但可以点『也放入』」⇒ 需要一个**状态机**（skipped → promoted）；
 *   · 「从列表里挑几条深挖」⇒ 需要 `bvid → 笔记路径` 的稳定映射。
 *
 * 落在 `<家>/today/<YYYY-MM-DD>.json`，一天一份、**按轮追加**（同一 bvid 不重复，
 * 已有状态优先保留 —— 使用者手动「放入」过的不会被下一轮冲掉）。
 *
 * 数据来源（两路都要能进）：
 *   ① 章程要求模型在日报末尾写一段 `<!-- BILI_TODAY ... -->` JSON（**主路**，见 duty.md）；
 *   ② 没有那段时，用 `parseReport()` 从日报的 `### 标题` 里**兜底解析**（老报告也能用）。
 * ============================================================================
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const todayDir = (stateDir) => join(stateDir, 'today')
export const todayFile = (stateDir, date) => join(todayDir(stateDir), `${date}.json`)

const nowIso = () => new Date().toISOString()

export function emptyToday(date) {
  return { date, round: 0, createdAt: nowIso(), updatedAt: nowIso(), items: [], skipped: [], meta: {} }
}

export function readToday(stateDir, date) {
  try {
    const doc = JSON.parse(readFileSync(todayFile(stateDir, date), 'utf8'))
    if (!doc || typeof doc !== 'object') return null
    doc.items = Array.isArray(doc.items) ? doc.items : []
    doc.skipped = Array.isArray(doc.skipped) ? doc.skipped : []
    return doc
  } catch { return null }
}

export function writeToday(stateDir, date, doc) {
  mkdirSync(todayDir(stateDir), { recursive: true })
  doc.updatedAt = nowIso()
  writeFileSync(todayFile(stateDir, date), JSON.stringify(doc, null, 2) + '\n', 'utf8')
  return doc
}

export function ensureToday(stateDir, date) {
  return readToday(stateDir, date) || emptyToday(date)
}

/** 按 bvid 合并一条：**已存在的不覆盖状态**（只有显式 setStatus 才改） */
export function upsertItem(doc, item) {
  const bvid = String(item?.bvid || '').trim()
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return false
  const list = doc.items
  const i = list.findIndex((x) => x.bvid === bvid)
  const clean = {
    bvid,
    title: String(item.title || '').trim(),
    up: String(item.up || '').trim(),
    duration: Number(item.duration) || 0,
    view: Number(item.view) || 0,
    pubdate: Number(item.pubdate) || 0,
    score: Number(item.score) || 0,
    reason: String(item.reason || '').trim(),
    why: String(item.why || '').trim(),
    mine: String(item.mine || '').trim(),
    // ⭐ 2026-10-18 使用者改口径：**看过的每一条都要有结论**（推荐 / 不推荐 + 理由），
    //    不再"好的才进列表" ⇒ 这条视频自己带 verdict。
    verdict: item.verdict === 'reject' ? 'reject' : 'pick',
    notePath: String(item.notePath || '').trim(),
    at: item.at || nowIso(),
  }
  if (i >= 0) {
    // 已有的保留 status / notePath / at；只补空缺字段（标题更容易拿到新的就更新）
    const old = list[i]
    list[i] = {
      ...old,
      title: clean.title || old.title,
      up: clean.up || old.up,
      duration: clean.duration || old.duration,
      view: clean.view || old.view,
      score: clean.score || old.score,
      reason: clean.reason || old.reason,
      why: clean.why || old.why,
      mine: clean.mine || old.mine,
      verdict: old.verdict || clean.verdict,
      notePath: old.notePath || clean.notePath,
    }
  } else {
    list.push({ ...clean, status: item.status || 'picked' })
  }
  // 从 skipped 里挪走（升级为 items 了）
  doc.skipped = doc.skipped.filter((x) => x.bvid !== bvid)
  return true
}

export function upsertSkipped(doc, item) {
  const bvid = String(item?.bvid || '').trim()
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return false
  if (doc.items.some((x) => x.bvid === bvid)) return false      // 已在推荐里
  const row = {
    bvid,
    title: String(item.title || '').trim(),
    up: String(item.up || '').trim(),
    score: Number(item.score) || 0,
    reason: String(item.reason || '').trim(),
    at: item.at || nowIso(),
  }
  const i = doc.skipped.findIndex((x) => x.bvid === bvid)
  if (i >= 0) doc.skipped[i] = { ...doc.skipped[i], ...row }
  else doc.skipped.push(row)
  return true
}

/** 一轮跑完：把这一轮的成果并进今天 */
export function recordRound(stateDir, date, { items = [], skipped = [], file = '', intent = '' } = {}) {
  const doc = ensureToday(stateDir, date)
  for (const it of items) upsertItem(doc, it)
  for (const it of skipped) upsertSkipped(doc, it)
  doc.round = Number(doc.round || 0) + 1
  doc.meta = {
    ...(doc.meta || {}),
    intent: intent || doc.meta?.intent || '',
    lastFile: file || doc.meta?.lastFile || '',
    lastRoundAt: nowIso(),
    roundFiles: [...(doc.meta?.roundFiles || []).filter((f) => f !== file), file].filter(Boolean).slice(-10),
  }
  return writeToday(stateDir, date, doc)
}

export function setStatus(stateDir, date, bvid, status, patch = {}) {
  const doc = ensureToday(stateDir, date)
  const i = doc.items.findIndex((x) => x.bvid === bvid)
  const extra = { ...patch, status, at: nowIso() }
  if (i >= 0) doc.items[i] = { ...doc.items[i], ...extra }
  else {
    const sk = doc.skipped.find((x) => x.bvid === bvid)
    doc.skipped = doc.skipped.filter((x) => x.bvid !== bvid)
    if (sk) doc.items.push({ ...sk, ...extra })
    else return null
  }
  writeToday(stateDir, date, doc)
  return doc.items.find((x) => x.bvid === bvid) || null
}

export function findItem(stateDir, date, bvid) {
  const doc = readToday(stateDir, date)
  if (!doc) return null
  return doc.items.find((x) => x.bvid === bvid) || doc.skipped.find((x) => x.bvid === bvid) || null
}

/* ─────────────── 文件夹（2026-10-18 加）───────────────
 * 使用者要「像文件夹那样分级」：默认每轮建一个，可以自己新建命名、把视频拖进去。
 * 落在 `doc.meta.folders = [{id,name,at}]`，条目上用 `item.folder = id` 归属。
 * 不用真的挪文件 —— 视频笔记路径不变，只是"归到哪个格子"。
 */
export function ensureFolders(doc) {
  if (!doc.meta || typeof doc.meta !== 'object') doc.meta = {}
  if (!Array.isArray(doc.meta.folders)) doc.meta.folders = []
  return doc.meta.folders
}

export function addFolder(doc, name) {
  const folders = ensureFolders(doc)
  const n = String(name || '').trim() || `文件夹 ${folders.length + 1}`
  const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  folders.push({ id, name: n.slice(0, 40), at: nowIso() })
  return { id, name: n.slice(0, 40) }
}

export function removeFolder(doc, id) {
  const folders = ensureFolders(doc)
  const i = folders.findIndex((f) => f.id === id)
  if (i < 0) return false
  folders.splice(i, 1)
  for (const it of doc.items) if (it.folder === id) it.folder = ''
  return true
}

export function assignFolder(doc, bvid, folderId) {
  const it = doc.items.find((x) => x.bvid === bvid)
  if (!it) return false
  it.folder = String(folderId || '')
  return true
}

/** 每轮跑完就把这批视频归到「第 N 轮 HH:MM」这个文件夹里（没有就建） */
export function folderForRound(doc, hm, roundNo) {
  const folders = ensureFolders(doc)
  const id = 'r' + String(hm || '').padStart(4, '0')
  let f = folders.find((x) => x.id === id)
  if (!f) {
    const clock = `${String(hm).slice(0, 2)}:${String(hm).slice(2, 4)}`
    f = { id, name: `第 ${roundNo || '?'} 轮 ${clock}`, at: nowIso() }
    folders.push(f)
  }
  return f.id
}

export function removeItem(doc, bvid) {
  const n = doc.items.length
  doc.items = doc.items.filter((x) => x.bvid !== bvid)
  return doc.items.length !== n
}

export function removeSkipped(doc, bvid) {
  const n = doc.skipped.length
  doc.skipped = doc.skipped.filter((x) => x.bvid !== bvid)
  return doc.skipped.length !== n
}

export function clearSkipped(doc) {
  const n = doc.skipped.length
  doc.skipped = []
  return n
}

export function listDates(stateDir) {  try {
    return readdirSync(todayDir(stateDir))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort()
      .reverse()
  } catch { return [] }
}

/** 只保留最近 N 天（默认 60），防止家目录越滚越大 */
export function prune(stateDir, keepDays = 60) {
  const dates = listDates(stateDir)
  const cut = dates.slice(Math.max(0, keepDays))
  for (const d of cut) {
    try { writeFileSync(todayFile(stateDir, d), '', 'utf8') } catch { /* 删不掉无所谓 */ }
  }
}

/* ─────────────── 从日报里解析（主路 marker + 兜底正则） ─────────────── */

const BV_RE = /\bBV[0-9A-Za-z]{10}\b/

/** 模型被要求在日报/笔记末尾写：<!-- BILI_TODAY [...] --> 或 <!-- BILI_ITEM {...} --> */
export function parseMarker(md) {
  const m = String(md || '').match(/<!--\s*BILI_(?:TODAY|ITEM)\s*([\s\S]*?)-->/)
  if (!m) return null
  let raw = m[1].trim()
  // 允许外面再包一层 ```json
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) || (arr && typeof arr === 'object') ? arr : null
  } catch { return null }
}

/**
 * 解析**一篇视频笔记**（0.1.4 的产物形态：一条视频一个 md）。
 * 主路是笔记末尾的 `<!-- BILI_ITEM {...} -->`；没有就按标题/链接/UP 兜底。
 * @returns {{bvid,title,up,duration,view,score,reason,verdict}|null}
 */
export function parseNote(md, filename = '') {
  const text = String(md || '').replace(/\r/g, '')
  const raw = parseMarker(text)
  const first = Array.isArray(raw) ? raw[0] : (raw && typeof raw === 'object' ? raw : null)
  const bv = first?.bvid || (text.match(BV_RE) || [])[0] || ''
  if (!/^BV[0-9A-Za-z]{10}$/.test(String(bv))) return null
  const titleLine = (text.match(/^#\s+(.+)$/m) || [])[1] || ''
  const upLine = (text.match(/\*\*UP\*\*\s*[：:/]?\s*([^｜|\n]+)/) || [])[1] || ''
  const scoreLine = (text.match(/评分[：:]\s*(\d+(?:\.\d+)?)/) || [])[1] || ''
  // ⭐ 2026-10-18 加：邮件里要摆「播放量 / 时长 / 为什么值得 / 我的一句话」，
  //    这些都写在每条笔记里了，直接摘出来即可（不用再让模型写一遍）。
  const viewLine = (text.match(/播放量\*{0,2}[：:]\s*([\d,]+)/) || [])[1] || ''
  const durLine = (text.match(/时长\*{0,2}[：:]\s*(\d{1,3}:\d{2}(?::\d{2})?)/) || [])[1] || ''
  const section = (name) => {
    const re = new RegExp('^##\\s*' + name + '\\s*$', 'm')
    const m = text.match(re)
    if (!m) return ''
    const start = m.index + m[0].length
    const rest = text.slice(start)
    const next = rest.search(/^##\s/m)
    return (next >= 0 ? rest.slice(0, next) : rest).replace(/<!--[\s\S]*?-->/g, '').trim()
  }
  return {
    bvid: bv,
    title: String(first?.title || titleLine || filename.replace(/\.md$/i, '')).trim(),
    up: String(first?.up || upLine || '').trim(),
    duration: durLine || (Number(first?.duration) ? String(first.duration) + 's' : ''),
    view: Number(String(viewLine).replace(/,/g, '')) || Number(first?.view) || 0,
    score: Number(first?.score ?? scoreLine) || 0,
    reason: String(first?.reason || '').trim(),
    why: section('为什么值得看') || section('为什么值得') || section('为什么不推荐') || section('为什么跳过') || String(first?.why || '').trim(),
    mine: section('我的一句话') || section('一句话') || String(first?.mine || '').trim(),
    verdict: /reject|skip|不推荐/i.test(String(first?.verdict || '')) ? 'reject' : 'pick',
    note: filename,
  }
}

/**
 * 兜底：从 `### 标题` / `## 标题` 段落里找 BV 号与评分。
 * 只求“能用”，解析不到就跳过 —— 宁可少一条，也不要编一条。
 */
export function parseReport(md, { picked = true } = {}) {
  const text = String(md || '').replace(/\r/g, '')
  const lines = text.split('\n')
  const out = []
  let cur = null
  const flush = () => {
    if (cur && cur.bvid) out.push(cur)
    cur = null
  }
  for (const line of lines) {
    const h = line.match(/^#{2,3}\s+(.+?)\s*$/)
    if (h && !/^#/.test(line.slice(4))) {
      const title = h[1].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim()
      // 标题里带 BV 或下一行会带 BV ⇒ 先记下标题
      const inTitle = title.match(BV_RE)
      if (inTitle) { flush(); cur = { bvid: inTitle[0], title, picked }; continue }
      if (cur && cur.bvid) { flush() }
      cur = { bvid: '', title, picked }
      continue
    }
    if (!cur) continue
    const bv = line.match(BV_RE)
    if (bv && !cur.bvid) cur.bvid = bv[0]
    const sc = line.match(/评分[：:]\s*(\d+(?:\.\d+)?)/)
    if (sc && !cur.score) cur.score = Number(sc[1])
    const rs = line.match(/^\s*(?:推荐理由|理由)[：:]\s*(.+)$/)
    if (rs && !cur.reason) cur.reason = rs[1].trim()
  }
  flush()
  return out.filter((x) => x.bvid)
}
