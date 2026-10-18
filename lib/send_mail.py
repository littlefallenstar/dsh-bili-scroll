#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
lib/send_mail.py —— **宿主自己发邮件**（不给 agent 发信能力）
============================================================================
用法：
    python send_mail.py --config <path/to/mail.json>
    python send_mail.py --config <path> --dry-run

配置（JSON）：
    { "host": "smtp.qq.com", "port": 465,
      "user": "x@qq.com", "pass": "授权码",
      "from": "x@qq.com", "to": ["y@qq.com"],
      "subject": "...", "file": "C:/path/report.md", "html": true }

    ⚠️ 兼容别名（本机 `.dsh/mail.json` 就是这种写法）：
        pass   ← 也认 auth_code / password
        from   ← 缺省时用 user
        to     ← 可以是数组，也可以是逗号分隔的字符串

行为：
    md → 简单 HTML（标题/列表/代码块/链接，**全部先转义**）→ SMTP_SSL 465 → 打印结果。
    stdout 只打一行：`[ok] sent to a@b, b@b` 或 `[fail] ...`，退出码 0/1。

🔴 安全：**授权码永远不出现在任何输出里**（包括异常信息）——打印前统一换成 `***`。
============================================================================
"""

import argparse
import html
import json
import os
import re
import smtplib
import ssl
import sys
import traceback
from email.headerregistry import Address
from email.message import EmailMessage
import email.policy


# ---------------------------------------------------------------- 输出 / 脱敏

def _utf8_streams():
    """把 stdout/stderr 钉成 UTF-8（Windows 控制台默认 GBK 会把中文和 HTML 弄炸）。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def mask_secret(text, secret):
    """把授权码从任意文本里抹掉。"""
    s = "" if text is None else str(text)
    if secret:
        s = s.replace(str(secret), "***")
    return s


# 进程内记住授权码，供最外层兜底异常处理器脱敏用（main 里赋值）
_SECRET = ""


# ---------------------------------------------------------------- 配置

def _pick(cfg, *names, default=None):
    """按顺序取第一个有值的键（兼容多种配置写法）。"""
    for name in names:
        if name in cfg:
            value = cfg.get(name)
            if value is not None and value != "":
                return value
    return default


def _as_list(value):
    """to 支持数组 / 逗号分隔字符串 / 单个字符串。"""
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        items = [str(v) for v in value]
    else:
        items = str(value).split(",")
    return [item.strip() for item in items if item and item.strip()]


# ---------------------------------------------------------------- markdown → html

def _escape(text):
    """先转义，再拼 HTML —— 顺序不能反过来（否则使用者正文里的 <script> 会漏出去）。"""
    return html.escape(text, quote=True)


def _link(match):
    label, url = match.group(1), match.group(2)
    scheme = url.strip().lower()
    if scheme.startswith(("javascript:", "data:", "vbscript:")):
        return "%s (%s)" % (label, url)
    return '<a href="%s">%s</a>' % (url, label)


def _inline(raw):
    """行内语法。raw 是**未转义**的纯文本，第一步就转义。"""
    text = _escape(raw)

    # 行内代码先挖出来，免得里面的 * / [ ] 被别的规则吃掉
    codes = []

    def _stash(match):
        codes.append(match.group(1))
        return "\x00%d\x00" % (len(codes) - 1)

    text = re.sub(r"`([^`\n]+)`", _stash, text)
    text = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", _link, text)
    text = re.sub(r"\*\*([^*\n]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"__([^_\n]+)__", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<![*\w])\*([^*\n]+)\*(?![*\w])", r"<em>\1</em>", text)
    text = re.sub(r"~~([^~\n]+)~~", r"<del>\1</del>", text)

    def _unstash(match):
        return "<code>%s</code>" % codes[int(match.group(1))]

    return re.sub(r"\x00(\d+)\x00", _unstash, text)


def md_to_html(md):
    """够看就行的 md → HTML：标题 / 列表 / 代码块 / 引用 / 分隔线 / 链接。"""
    lines = str(md).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out = []
    para = []
    open_lists = []
    i = 0

    def close_lists():
        while open_lists:
            out.append("</%s>" % open_lists.pop())

    def flush_para():
        if para:
            out.append("<p>%s</p>" % _inline(" ".join(para)))
            del para[:]

    while i < len(lines):
        line = lines[i].strip()

        # 围栏代码块
        if line.startswith("```"):
            flush_para()
            close_lists()
            lang = line[3:].strip()
            i += 1
            code = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code.append(lines[i])
                i += 1
            if i < len(lines):
                i += 1  # 跳过收尾围栏
            attr = ' class="language-%s"' % _escape(lang) if lang else ""
            out.append("<pre><code%s>%s</code></pre>"
                       % (attr, _escape("\n".join(code))))
            continue

        if not line:
            flush_para()
            close_lists()
            i += 1
            continue

        # 标题
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            flush_para()
            close_lists()
            level = len(m.group(1))
            out.append("<h%d>%s</h%d>" % (level, _inline(m.group(2)), level))
            i += 1
            continue

        # 分隔线
        if re.match(r"^(-{3,}|\*{3,}|_{3,})$", line):
            flush_para()
            close_lists()
            out.append("<hr>")
            i += 1
            continue

        # 无序列表
        m = re.match(r"^[-*+]\s+(.*)$", line)
        if m:
            flush_para()
            if not open_lists or open_lists[-1] != "ul":
                close_lists()
                out.append("<ul>")
                open_lists.append("ul")
            out.append("<li>%s</li>" % _inline(m.group(1)))
            i += 1
            continue

        # 有序列表
        m = re.match(r"^(\d{1,9})[.)]\s+(.*)$", line)
        if m:
            flush_para()
            if not open_lists or open_lists[-1] != "ol":
                close_lists()
                out.append("<ol>")
                open_lists.append("ol")
            out.append("<li>%s</li>" % _inline(m.group(2)))
            i += 1
            continue

        # 引用（连续几行并成一段）
        m = re.match(r"^>\s?(.*)$", line)
        if m:
            flush_para()
            close_lists()
            quote = [m.group(1)]
            i += 1
            while i < len(lines):
                mm = re.match(r"^>\s?(.*)$", lines[i].strip())
                if not mm:
                    break
                quote.append(mm.group(1))
                i += 1
            out.append("<blockquote><p>%s</p></blockquote>" % _inline(" ".join(quote)))
            continue

        # 普通段落
        para.append(line)
        i += 1

    flush_para()
    close_lists()
    return "\n".join(out)


HTML_DOC = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%(subject)s</title>
</head>
<body style="margin:0;padding:24px;background:#f6f7f9;">
<div style="max-width:760px;margin:0 auto;background:#fff;border-radius:10px;
            padding:24px 28px;font:15px/1.75 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;
            color:#222;">
%(body)s
</div>
</body>
</html>
"""


def render_document(subject, body_html):
    return HTML_DOC % {"subject": _escape(subject), "body": body_html}


# ---------------------------------------------------------------- 发送

def _build_message(subject, sender, from_name, recipients, plain, doc_html, want_html):
    # policy=default 才会自动按 RFC 2047 编码中文主题/发件人名
    msg = EmailMessage(policy=email.policy.default)
    msg["Subject"] = subject
    msg["From"] = Address(display_name=from_name or "", addr_spec=sender)
    msg["To"] = ", ".join(recipients)
    msg.set_content(plain)
    if want_html:
        msg.add_alternative(doc_html, subtype="html")
    return msg


def main(argv=None):
    _utf8_streams()

    parser = argparse.ArgumentParser(
        description="把一份 markdown 报告用 SMTP_SSL 发出去（宿主侧，不给 agent 用）",
    )
    parser.add_argument("--config", required=True, help="mail.json 路径")
    parser.add_argument("--dry-run", action="store_true",
                        help="只渲染不发送（打印 HTML 前 400 字符）")
    # 三个可选覆盖项：让 lib/mail.mjs 不用把授权码写进临时文件也能改收件人/主题
    parser.add_argument("--file", default=None, help="覆盖配置里的 file")
    parser.add_argument("--subject", default=None, help="覆盖配置里的 subject")
    parser.add_argument("--to", default=None, help="覆盖收件人（逗号分隔）")
    args = parser.parse_args(argv)

    # ---- 读配置
    cfg_path = os.path.abspath(os.path.expanduser(args.config))
    try:
        with open(cfg_path, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
        if not isinstance(cfg, dict):
            raise ValueError("顶层不是对象")
    except Exception as exc:
        print("[fail] 读不到配置或不是合法 JSON：%s（%s）" % (cfg_path, exc))
        return 1

    secret = str(_pick(cfg, "pass", "auth_code", "password", "smtp_pass",
                       default="") or "")
    global _SECRET
    _SECRET = secret

    def say(text):
        print(mask_secret(text, secret))

    # ---- 取字段
    md_path = str(args.file or _pick(cfg, "file", "report", "md", default="") or "")
    if not md_path:
        say("[fail] 配置里没有 file，也没有给 --file")
        return 1
    md_path = os.path.abspath(os.path.expanduser(md_path))
    if not os.path.isfile(md_path):
        say("[fail] 找不到文件：%s" % md_path)
        return 1

    try:
        with open(md_path, "r", encoding="utf-8", errors="replace") as fh:
            md_text = fh.read()
    except Exception as exc:
        say("[fail] 读文件失败：%s（%s）" % (md_path, exc))
        return 1

    subject = str(args.subject or _pick(cfg, "subject", "title",
                                        default="") or "")
    if not subject:
        subject = str(_pick(cfg, "subject_prefix", default="") or "") + os.path.basename(md_path)

    recipients = _as_list(args.to) or _as_list(_pick(cfg, "to", "rcpt", default=None))
    if not recipients:
        say("[fail] 没有收件人（配置 to / --to）")
        return 1

    want_html = bool(_pick(cfg, "html", default=True))
    body_html = md_to_html(md_text)
    doc_html = render_document(subject, body_html)

    # ---- dry-run：只渲染，不碰 SMTP
    if args.dry_run:
        say("[dry-run] file=%s" % md_path)
        say("[dry-run] subject=%s" % subject)
        say("[dry-run] to=%s" % ", ".join(recipients))
        say("[dry-run] md→html 前 400 字符：")
        say(body_html[:400])
        return 0

    # ---- 真发
    host = str(_pick(cfg, "host", "smtp_host", default="") or "")
    port = int(_pick(cfg, "port", "smtp_port", default=465) or 465)
    user = str(_pick(cfg, "user", "username", "account", default="") or "")
    sender = str(_pick(cfg, "from", "sender", "from_addr", default="") or user)
    from_name = str(_pick(cfg, "from_name", "fromName", "name", default="") or "")

    if not host or not sender:
        say("[fail] 配置缺 host 或 from/user")
        return 1

    try:
        msg = _build_message(subject, sender, from_name, recipients,
                             md_text, doc_html, want_html)
    except Exception as exc:
        say("[fail] 构造邮件失败：%s: %s" % (type(exc).__name__, exc))
        return 1

    try:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(host, port, timeout=60, context=context) as smtp:
            if user and secret:
                smtp.login(user, secret)
            refused = smtp.send_message(msg)
    except Exception as exc:
        say("[fail] 发送失败：%s: %s" % (type(exc).__name__, exc))
        return 1

    # 有地址被 RCPT 拒收 ⇒ 就不算成功（QQ 对不存在/未授权地址会在这里拒）
    if refused:
        say("[fail] 这些地址被服务器拒收：%s" % ", ".join(sorted(refused)))
        return 1

    say("[ok] sent to %s" % ", ".join(recipients))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(1)
    except Exception:  # 兜底：连堆栈也不许带出授权码
        sys.stderr.write("[fail] 未预期的错误\n")
        sys.stderr.write(mask_secret(traceback.format_exc(), _SECRET))
        sys.exit(1)
