# -*- coding: utf-8 -*-
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 MaiBot Launcher Contributors
#
# 来源：本项目（MaiBot Launcher）自研代码，不是第三方文件。
# 随安装包分发到 resources/ansi-shim/sitecustomize.py，仅通过 PYTHONPATH
# 在启动器拉起的子进程里生效（见本文件末尾「怎么停用」）。
"""
MaiBot 启动器的 ANSI 保色垫片（sitecustomize）。

为什么需要它
------------------------------------------------------------------
麦麦启动时会用 colorama 打一句彩虹彩蛋（见 bot.py 的 easter_egg()）：

    rainbow_colors = [Fore.RED, Fore.YELLOW, Fore.GREEN, ...]

而 colorama 的设计前提是"我只负责往 Windows 控制台写颜色"：
一旦发现 stdout **不是终端**（被重定向、被管道接走），
它会把 ANSI 颜色码**全部删掉**，免得把转义序列喷进文件里。
它不认 FORCE_COLOR / CLICOLOR_FORCE / TERM 任何一个环境变量
（0.4.6 实测：四种环境变量全试过，颜色码一律被删）。

启动器就是"用管道接走输出"的那一方（要抓日志给人看），
于是这句彩虹到了日志页就变成一行白字。

但这里有个关键事实：**启动器的日志页现在真的会渲染 ANSI**
（LogsPanel.vue 里有 256 色/真彩色/加粗的解析器）。
所以"接收端不支持颜色"这个前提，对这个接收端来说是**假的**。
这个垫片做的事情只有一件：把 strip / convert 关掉，让颜色码原样流出来，
交给真正会渲染它的那一端。

它不动麦麦的任何文件，也不改麦麦的代码：
只通过 PYTHONPATH 在启动器拉起的子进程里生效。
你自己在 cmd 里跑麦麦时，这个文件根本不会被加载，行为一切照旧。

怎么停用：把启动器里 PYTHONPATH 这个垫片目录去掉即可（见 process.js 的 applyColorEnv）。
"""

import os  # noqa: F401  （保持与普通 sitecustomize 一致的可用性）

_PATCHED = False


def _patch_colorama():
    """把 colorama 的 AnsiToWin32 改成"不转换、不剥离"，其余行为不变。"""
    global _PATCHED
    if _PATCHED:
        return
    try:
        from colorama.ansitowin32 import AnsiToWin32
    except Exception:
        # 没有 colorama（或版本变了）就什么都不做 —— 垫片绝不能把服务搞挂
        return

    _orig_init = AnsiToWin32.__init__

    def _init(self, *args, **kwargs):
        # 只强制 convert=False / strip=False，其余原样透传。
        # ⚠️ 这里刻意不写参数名：colorama 0.4.6 的签名是
        #     (wrapped, convert=None, strip=None, autoreset=False)
        # 第一个参数叫 wrapped 而不是 stream —— 一开始按 stream 写，
        # 直接 TypeError: unexpected keyword argument 'stream'，
        # 而那是从 easter_egg() 里 init() 的调用链上抛出来的，
        # 会把麦麦的启动流程打断。所以只按位置传。
        if len(args) > 1:
            args = args[:1]  # 位置参数只保留 wrapped，避免和下面的关键字撞车
        kwargs.pop("convert", None)
        kwargs.pop("strip", None)
        kwargs["convert"] = False
        kwargs["strip"] = False
        return _orig_init(self, *args, **kwargs)

    AnsiToWin32.__init__ = _init
    _PATCHED = True


_patch_colorama()
