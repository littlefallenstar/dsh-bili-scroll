/**
 * lib/mail.mjs —— 邮件这一侧的 Node 包装
 * ============================================================================
 * 分工：
 *   · 真正发信在 `lib/send_mail.py`（纯标准库 smtplib）—— **宿主自己发**，
 *     不给 agent 任何发信工具，agent 只能写报告，不能挑收件人。
 *   · 本文件只做三件事：**存/读配置**、**收文件 ACL**、**spawn Python 发出去**。
 *
 * 🔴 两条硬规矩：
 *   ① 配置文件里有授权码 ⇒ 在 Windows 上**用 icacls 把继承砍掉、只留给当前用户**
 *      （失败不抛，返回一句警告交给调用方去说）。
 *   ② Python 的 stdout/stderr 在**返回之前**要把授权码换成 `*****` ——
 *      调用方（可能是个 logger、也可能是 agent 读到的工具输出）不该看见它。
 *
 * 只用 node:fs / node:child_process / node:path（+ 内置的 import.meta.dirname），
 * 不引第三方依赖。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'

/** 真正干活的那个 Python 脚本（与本文件同目录） */
const PY_SCRIPT = join(import.meta.dirname, 'send_mail.py')

/** 超时：90 秒还没回来就杀掉（SMTP 卡住不该把宿主一起拖住） */
const TIMEOUT_MS = 90_000

/** 授权码在输出里的替身 */
const MASK = '*****'

/**
 * 配置文件路径：`<stateDir>/mail.json`
 * @param {string} stateDir 插件自己的家
 * @returns {string}
 */
export function mailConfigPath(stateDir) {
  return join(String(stateDir), 'mail.json')
}

/**
 * 读配置。**读不到 / 坏 JSON 一律返回 null**（不抛）。
 * @param {string} stateDir
 * @returns {object|null}
 */
export function loadMailConfig(stateDir) {
  try {
    const cfg = JSON.parse(readFileSync(mailConfigPath(stateDir), 'utf8'))
    return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : null
  } catch {
    return null
  }
}

/**
 * 写配置，并在 Windows 上把文件 ACL 收成"仅当前用户"。
 *
 * icacls 命令（与需求一致）：
 *   `icacls <file> /inheritance:r /grant:r "<用户名>":F`
 * 用 spawnSync 且 **args 分开传**（不经 shell，用户名里的空格/中文不会被拆开）。
 *
 * @param {string} stateDir
 * @param {object} cfg
 * @returns {string} 警告字符串（空串 = 一切正常）；**永不抛**
 */
export function saveMailConfig(stateDir, cfg) {
  const file = mailConfigPath(stateDir)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(cfg ?? {}, null, 2) + '\n', 'utf8')
  } catch (e) {
    return `写邮件配置失败：${e?.message ?? e}`
  }

  if (process.platform !== 'win32') return ''

  // 当前用户名：优先 USERNAME，退到 USERPROFILE 的最后一段
  const user = process.env.USERNAME
    || (process.env.USERPROFILE || '').split(/[\\/]/).filter(Boolean).pop()
    || ''
  if (!user) return 'ACL 未收：拿不到当前用户名'

  try {
    const r = spawnSync(
      'icacls',
      [file, '/inheritance:r', '/grant:r', `${user}:F`],
      { encoding: 'utf8', windowsHide: true },
    )
    if (r.error) return `ACL 未收：icacls 起不来（${r.error.message}）`
    if (r.status !== 0) {
      const detail = String(r.stderr || r.stdout || '').trim().split('\n')[0]
      return `ACL 未收：icacls 退出码 ${r.status}${detail ? `（${detail}）` : ''}`
    }
    return ''
  } catch (e) {
    return `ACL 未收：${e?.message ?? e}`
  }
}

/**
 * 把文本里出现的授权码全部换成 `*****`。
 *
 * 兼容几种写法：`pass` / `auth_code` / `password`。
 * 太短的串（< 2 字符）不动 —— 否则会把正常文本打烂。
 *
 * @param {string} text
 * @param {object|null} cfg
 * @returns {string}
 */
export function maskSecrets(text, cfg) {
  let s = String(text ?? '')
  if (!cfg || typeof cfg !== 'object') return s
  for (const key of ['pass', 'auth_code', 'password', 'smtp_pass']) {
    const v = cfg[key]
    if (typeof v === 'string' && v.length >= 2) s = s.split(v).join(MASK)
  }
  return s
}

/** to 支持数组 / 逗号分隔字符串 / 单值 */
function normTo(value) {
  if (value == null) return []
  const list = Array.isArray(value) ? value : String(value).split(',')
  return list.map((v) => String(v).trim()).filter(Boolean)
}

/**
 * 发一份报告。
 *
 * @param {string} stateDir 插件自己的家（配置、venv 都在这里）
 * @param {{ file?: string, subject?: string, to?: string|string[] }} opts
 * @returns {Promise<{ ok: boolean, out: string, err: string }>}
 */
export async function sendReport(stateDir, { file, subject, to } = {}) {
  const cfgPath = mailConfigPath(stateDir)
  const cfg = loadMailConfig(stateDir)
  if (!cfg) {
    return { ok: false, out: '', err: `没有可用的邮件配置：${cfgPath}` }
  }

  // python：家里有 venv 就用它（装过依赖的那一个），否则用 PATH 里的
  const venvPy = join(String(stateDir), '.venv', 'Scripts', 'python.exe')
  const py = existsSync(venvPy) ? venvPy : 'python'

  const args = [PY_SCRIPT, '--config', cfgPath]
  if (file) args.push('--file', String(file))
  if (subject) args.push('--subject', String(subject))
  const rcpt = normTo(to ?? cfg.to)
  if (rcpt.length) args.push('--to', rcpt.join(','))

  // Python 的 UTF-8 三件套（沿用 lib/pyenv.mjs 的做法，这里内联，避免多一个 import）
  const env = {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
  }

  const raw = await new Promise((resolve) => {
    let out = ''
    let err = ''
    let timedOut = false
    let settled = false
    let timer = null

    const finish = (ok, extraErr = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: ok && !timedOut, out, err: err + extraErr })
    }

    let child
    try {
      child = spawn(py, args, { cwd: String(stateDir), env, windowsHide: true })
    } catch (e) {
      resolve({ ok: false, out: '', err: `python 起不来：${e?.message ?? e}` })
      return
    }

    timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* 已经退了 */ }
    }, TIMEOUT_MS)

    child.stdout?.on('data', (b) => { out += String(b) })
    child.stderr?.on('data', (b) => { err += String(b) })
    child.on('error', (e) => {
      const hint = e?.code === 'ENOENT'
        ? `找不到 Python（${py}）—— 先在本机装一个，或把 venv 建到 ${join(String(stateDir), '.venv')}`
        : String(e?.message ?? e)
      finish(false, (err ? '\n' : '') + hint)
    })
    child.on('close', (code) => {
      finish(code === 0, timedOut ? `\n[超时] ${TIMEOUT_MS / 1000} 秒未返回，已终止` : '')
    })
  })

  // 🔴 返回之前先把授权码抹掉
  return {
    ok: raw.ok,
    out: maskSecrets(raw.out, cfg),
    err: maskSecrets(raw.err, cfg),
  }
}
