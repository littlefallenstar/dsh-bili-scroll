const fs = require('fs')
let c = fs.readFileSync('CHANGELOG.md', 'utf8')
const anchor = `- 续刷间隔默认从 1 分钟改成 **5 分钟**（1 分钟太密）。`
if (!c.includes(anchor)) throw new Error('anchor')
c = c.replace(anchor, `- 续刷间隔默认从 1 分钟改成 **5 分钟**（1 分钟太密）。

**顺手补的三处（自查出来的）**
- 面板轮询和定时器可能同时走到发信那一步 ⇒ 加"正在发"标记，后来那条等前一条发完再发（不会漏信）。
- 邮箱开关关着时会在日志里说一句 \`发信跳过：邮箱没开\`，不再静默。
- \`todayKeepDays\` 之前只有配置没人执行 ⇒ 现在每小时清一次过期的今日表（默认留 60 天）。`)
fs.writeFileSync('CHANGELOG.md', c)
console.log('ok')
