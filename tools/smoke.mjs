/**
 * _smoke.mjs —— 宿主半端的**行为**冒烟（不只是"apply 不抛"）
 * 直接在假 ctx 上挂路由，用假 req/res 打一遍 /today 系列，验证：
 *   ① 只认"今天的产物"；② marker 解析；③ 跳过表；④ promote 升级；⑤ 幂等（跑两遍条目数不变）
 *
 * 跑：DSH_HOST_MODULES=<profile>/node_modules/@deepseek-ai node --import ./tools/register.mjs tools/smoke.mjs
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'

const HOME = join(tmpdir(), 'dsh-bili-smoke')
rmSync(HOME, { force: true, recursive: true })
const SD = join(HOME, 'bili-duty')
mkdirSync(join(SD, 'reports'), { recursive: true })

let routes = null
const fakeCtx = {
  get: (k) => (k === 'dshHomePath' ? (...seg) => join(HOME, ...seg) : undefined),
  logger: { info: () => {}, warn: () => {} },
  tools: { register: (t) => t },
  webServer: { register: (spec) => { routes = spec?.handler ?? spec; return { dispose() {} } } },
  effect: (fn) => { try { return fn() } catch { return undefined } },
  settings: { register: () => ({}) },
  slots: { inject: () => {}, register: () => ({}) },
}

const mod = await import('../index.js')
mod.apply(fakeCtx, {})
if (!routes) throw new Error('没有挂上 webServer 路由')

/* ── 假 req/res ── */
function call(method, url, body) {
  const req = new EventEmitter()
  req.method = method; req.url = url; req.headers = { host: '127.0.0.1' }
  process.nextTick(() => {
    if (body) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  const res = {
    statusCode: 0, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v },
    writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h ?? {}) },
    end(b) { this.body = String(b ?? '') },
    write(b) { this.body += String(b ?? '') },
  }
  return routes(req, res).then(() => res.body)
}

const now = new Date()
const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
const stamp = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`

// 今天的产物（带 marker）
writeFileSync(join(SD, 'reports', `测试视频A-${stamp}.md`), [
  '# 测试视频A', '',
  '- UP：某UP', '- BV：BV1aaaaaaaaa', '',
  '## 讲了什么', '一句话。', '',
  '<!-- BILI_ITEM {"bvid":"BV1aaaaaaaaa","score":8,"reason":"讲了插件宿主配置","verdict":"pick"} -->', '',
].join('\n'), 'utf8')
// 老的产物（昨天）—— 不该进今日列表
writeFileSync(join(SD, 'reports', '老视频-991231.md'), '# 老视频\n\n<!-- BILI_ITEM {"bvid":"BV1bbbbbbbbb","score":9,"reason":"旧的"} -->\n', 'utf8')
const old = new Date(Date.now() - 3 * 86400_000)
utimesSync(join(SD, 'reports', '老视频-991231.md'), old, old)

// 判重表里留一条"跳过"
writeFileSync(join(SD, 'seen.md'), [
  '# 判重表', '',
  '| BV | 日期 | 怎么来的 | rpid | 备注 |', '|---|---|---|---|---|',
  `| BV1ccccccccc | ${ymd} | 看过 |  | 跳过：纯入门教程 |`, '',
].join('\n'), 'utf8')

const r1 = JSON.parse(await call('GET', `/api/bili-duty/today?date=${ymd}`))
console.log('① items =', r1.items.map((i) => `${i.bvid}/${i.status}/${i.score}`).join(', '))
console.log('   first =', JSON.stringify(r1.items[0]))
console.log('② skipped =', r1.skipped.map((s) => `${s.bvid}:${s.reason}`).join(', '))
console.log('③ counts =', JSON.stringify(r1.counts), ' dates =', JSON.stringify(r1.dates))
if (!r1.items.find((i) => i.bvid === 'BV1aaaaaaaaa')) throw new Error('今天的产物没进列表')
if (r1.items.find((i) => i.bvid === 'BV1bbbbbbbbb')) throw new Error('昨天的产物混进来了')
if (!r1.skipped.find((s) => s.bvid === 'BV1ccccccccc')) throw new Error('跳过没记上')

const r2 = JSON.parse(await call('GET', `/api/bili-duty/today?date=${ymd}`))
if (r2.items.length !== r1.items.length) throw new Error('跑两遍条目数变了（不幂等）')
console.log('④ 幂等 OK')

const r3 = JSON.parse(await call('POST', '/api/bili-duty/today/promote', { bvid: 'BV1ccccccccc' }))
console.log('⑤ promote →', r3.ok, r3.item?.status, ' items 现在 =', r3.doc?.items?.length)
if (!r3.ok || r3.item.status !== 'promoted') throw new Error('promote 没把跳过升成 picked')

// 磁盘上真的写了 today/<date>.json
const disk = JSON.parse(readFileSync(join(SD, 'today', `${ymd}.json`), 'utf8'))
console.log('⑥ 落盘 =', `${ymd}.json`, 'items', disk.items.length, 'skipped', disk.skipped.length)
console.log('\n✅ 冒烟全过')
