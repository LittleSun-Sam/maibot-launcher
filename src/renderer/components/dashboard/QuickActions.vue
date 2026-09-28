<template>
  <div class="quick">
    <button
      v-for="a in actions"
      :key="a.key"
      type="button"
      class="quick-btn"
      :class="{ disabled: a.disabled, loading: a.loading }"
      :disabled="a.disabled"
      @click="!a.disabled && a.action()"
    >
      <IconGlyph :name="a.icon" class="quick-ico" />
      <span class="quick-label">{{ a.label }}</span>
    </button>
  </div>
</template>

<script setup>
/*
================================================================================
技术文档：src/renderer/components/dashboard/QuickActions.vue
职责：总览页快捷操作（启停服务、清理残留、跳转、退出）。
================================================================================
  相对重构前的修正：
    1) "清理残留"是假汇报（真实问题）
       原代码：`const r = await killZombie(); if (r && r.ok) toast('已清理残留进程')`。
       而旧主进程实现只判断 PowerShell 的退出码是否为 0 —— 只要命令跑起来
       就算成功，哪怕一个进程都没匹配到，也会提示"已清理残留进程"。
       → 现在：主进程返回真实的 found / killed 计数，这里如实展示
         「未发现残留进程」/「已终止 N 个」/「发现 N 个但全部终止失败」。
    2) 全部启动/停止忽略失败
       原代码用 `.catch(() => {})` 把错误全部吞掉 —— 启动失败时用户看不到
       任何反馈，只会觉得"点了没反应"。
       → 现在：收集每个服务的结果并汇总提示。
    3) 启动前不校验配置，未设置目录时静默什么也不做。
       → 现在：明确提示缺少哪一项配置。
================================================================================
*/
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import IconGlyph from '../IconGlyph.vue';
import { toast } from '../../composables/useToast.js';
import {
  buildStartPayload,
  cleanupZombies,
  confirmDialog,
  exitApp,
  refreshServices,
  resolveStartPayload,
  serviceOf,
  startService,
  stopService
} from '../../stores/app-store.js';

const router = useRouter();

/**
 * 进行中的动作 key（'' 表示空闲）。
 * 此前所有动作的 disabled 恒为 false，`:disabled` 是死代码，
 * 双击「全部启动」会让两次 doStartAll 并发（两者都在 isRunning 为 false 时通过，
 * 而 startService 只在返回后才刷新状态）→ 同一服务两次启动请求、汇总互相覆盖。
 */
const busy = ref('');

/** 服务是否在运行 */
function isRunning(key) {
  return Boolean(serviceOf(key).running);
}

/*
  服务显示名。
  此前这里把内部 key（'maibot' / 'snowluma'）和配置字段名
  （'maibotDir' / 'snowlumaDir'）直接拼进用户文案 ——
  用户看到的是标识符而不是产品名。
*/
const SERVICE_NAME = { maibot: 'MaiBot', snowluma: 'SnowLuma' };
const DIR_FIELD = { maibot: 'MaiBot 目录', snowluma: 'SnowLuma 目录' };

/*
  启动顺序：先协议端（SnowLuma），后 MaiBot。
  与主进程 autoStartConfigured（process.js）保持同一策略，理由也一样：
  麦麦的适配器插件是 WS **客户端**，连的是 SnowLuma 那边的正向 WS 服务器。
  MaiBot 先起会连不上并刷一屏"连接失败"，用户容易误判成装坏了。

  停止顺序则**相反**（先 MaiBot）：协议端先消失会让仍在运行的
  适配器插件开始刷重连失败日志。两边都写成常量，
  免得以后加服务时只改了一处、顺序悄悄反掉。
*/
const START_ORDER = ['snowluma', 'maibot'];
const STOP_ORDER = ['maibot', 'snowluma'];

async function doStartAll() {
  if (busy.value) return;
  busy.value = 'start_all';
  try {
    /*
      用结构化结果，不用中文字符串做成败判定。
      此前是 `results.filter(t => t.includes('失败') || t.includes('未配置'))`——
      严重级别取决于文案措辞：改一个字（比如"失败"→"未能"）就会静默把
      错误降级成成功提示，而且没有任何测试能发现。
    */
    const out = [];
    for (const key of START_ORDER) {
      const label = SERVICE_NAME[key];
      if (isRunning(key)) {
        out.push({ ok: true, text: `${label} 已在运行` });
        continue;
      }
      /*
        必须先问主进程：只有它能真的去目录里探测 SnowLuma 的入口文件名
        （index.mjs / launcher.bat，随版本可能变）。
        渲染层的 buildStartPayload 只能拼一个硬编码的文件名，
        入口名一换就会 spawn 失败。
        与 OverviewPanel 的 resolvePayload 保持同一策略：
        主进程探测为主，"设置改了还没保存"的草稿作为兜底。
      */
      const probe = await resolveStartPayload(key);
      const payload = probe?.ok && probe.payload ? probe.payload : buildStartPayload(key);
      if (!payload) {
        out.push({ ok: false, text: `${label} 未配置目录（请在「设置」中填写${DIR_FIELD[key]}）` });
        continue;
      }
      const r = await startService(payload);
      /*
        这里原来只有"成功/失败"两档，于是两种中间态都被说反了：
        busy（上一次启动还没结束）被报成失败，degraded（进程起来了、
        端口还没开）被报成成功。现在按真实状态措辞，并且把 degraded
        算进"没完全成功"，让下面汇总的 toast 用警告色而不是绿色。
      */
      out.push({
        ok: Boolean(r?.ok) && !r?.degraded,
        text: r?.busy
          ? `${label} 正在启动中`
          : r?.degraded
            ? `${label} 已启动（端口尚未就绪）`
            : r?.ok
              ? `${label} 已启动`
              : `${label} 启动失败：${r?.message || '未知原因'}`
      });
    }
    await refreshServices();
    const bad = out.filter((x) => !x.ok).length;
    toast(
      out.map((x) => x.text).join('；'),
      bad ? (bad === out.length ? 'error' : 'warn') : 'success',
      5200
    );
  } finally {
    busy.value = '';
  }
}

async function doStopAll() {
  /*
    停止要**覆盖所有在跑的服务**，而不是只覆盖当初写代码时存在的那两个。
    顺序按 STOP_ORDER：MaiBot 先停，协议端后停。
  */
  const running = STOP_ORDER.filter((k) => isRunning(k));
  if (!running.length) {
    toast('当前没有正在运行的服务', 'info');
    return;
  }
  if (busy.value) return;
  busy.value = 'stop_all';

  try {
    const out = [];
    for (const key of running) {
      const r = await stopService(key);
      out.push({
        ok: Boolean(r?.ok),
        text: r?.ok
          ? `${SERVICE_NAME[key]} 已停止`
          : `${SERVICE_NAME[key]} 停止失败：${r?.message || '未知原因'}`
      });
    }
    await refreshServices();
    const bad = out.filter((x) => !x.ok).length;
    toast(out.map((x) => x.text).join('；'), bad ? 'error' : 'success', 5200);
  } finally {
    busy.value = '';
  }
}

/**
 * 退出应用。
 * 此前直接调 window.maibotApi.exitApp()：
 *   1) 绕过 store 封装层（app-store.js 已有 exitApp），桥缺失时同步抛 TypeError；
 *   2) 同页「清理残留」都要二次确认，而**退出整个应用**（会连带停掉子服务）零确认；
 *   3) 模板内联表达式不接管返回值 → unhandled rejection。
 */
async function doExit() {
  const yes = await confirmDialog({
    type: 'question',
    title: '退出启动器',
    message: '将关闭启动器窗口并停止由它管理的子服务。',
    detail: '如果只想收起窗口，请使用窗口右上角的「最小化到托盘」。',
    buttons: ['取消', '退出'],
    defaultId: 0
  });
  if (!yes) return;
  try {
    await exitApp();
  } catch (e) {
    toast('退出失败：' + (e?.message || e), 'error');
  }
}

/**
 * 清理残留进程。
 * 先用 dryRun 探测，再决定是否真的终止 —— 并且如实汇报数量。
 */
async function doKill() {
  if (busy.value) return;
  busy.value = 'kill';
  try {
    const probe = await cleanupZombies({ dryRun: true });
    /*
      先判失败再判数量。此前只看 probe.found：
      调用失败时 found 为 0/false，会走进"未发现残留进程"——
      把"探测失败"说成"没有残留"，用户以为一切正常。
    */
    if (probe && probe.ok === false) {
      toast(probe.message || '探测残留进程失败', 'error', 5000);
      return;
    }
    if (!probe?.found) {
      toast('未发现残留进程', 'info');
      return;
    }

    const r = await cleanupZombies({ dryRun: false });
    await refreshServices();

    if (r && r.ok === false) {
      /* 真正的失败原因来自主进程，不要编造"发现 0 个却杀不掉" */
      toast(r.message || '清理残留进程失败', 'error', 5500);
      return;
    }
    const found = Number(r?.found) || 0;
    const killed = Number(r?.killed) || 0;

    if (killed === 0 && found > 0) {
      /* 发现了但一个都没杀掉：必须如实告知，不能报成功 */
      toast(`发现 ${found} 个残留进程，但全部终止失败（可能需要管理员权限）`, 'error', 6000);
      return;
    }
    if (killed < found) {
      toast(`已终止 ${killed}/${found} 个残留进程，部分失败`, 'warn', 5500);
      return;
    }
    toast(`已终止 ${killed} 个残留进程`, 'success');
  } catch (e) {
    toast('清理失败：' + (e?.message || e), 'error');
  } finally {
    busy.value = '';
  }
}

/*
  进行中状态（busy 已在文件上方声明）：此前所有动作的 disabled 恒为 false，
  `:disabled` 是死代码，双击「全部启动」会让两次 doStartAll 并发
  （两者都在 isRunning 为 false 时通过，而 startService 只在返回后才刷新状态）
  → 同一服务两次启动请求、汇总互相覆盖。
*/
const actions = computed(() => {
  const running = Boolean(busy.value);
  return [
    {
      key: 'start_all',
      label: '全部启动',
      icon: 'play',
      action: doStartAll,
      disabled: running,
      loading: busy.value === 'start_all'
    },
    {
      key: 'stop_all',
      label: '全部停止',
      icon: 'stop',
      action: doStopAll,
      disabled: running,
      loading: busy.value === 'stop_all'
    },
    {
      key: 'kill',
      label: '清理残留',
      icon: 'bolt',
      action: doKill,
      disabled: running,
      loading: busy.value === 'kill'
    },
    { key: 'settings', label: '打开设置', icon: 'sliders', action: () => router.push('/settings'), disabled: false },
    { key: 'logs', label: '打开日志', icon: 'stream', action: () => router.push('/logs'), disabled: false },
    { key: 'terminal', label: '打开终端', icon: 'terminal', action: () => router.push('/terminal'), disabled: false },
    {
      key: 'exit',
      label: '退出应用',
      icon: 'close',
      action: doExit,
      disabled: false
    }
  ];
});
</script>

<style scoped>
.quick {
  display: grid;
  /* 现在放在总览页的通栏卡片里，2 列比 4 列更易读 */
  grid-template-columns: repeat(2, 1fr);
  gap: 0.5rem;
  min-height: 100%;
  align-content: center;
}

.quick-btn {
  letter-spacing: var(--ls-sm);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border: none;
  border-radius: var(--radius-sm);
  background: rgba(0, 0, 0, 0.04);
  color: var(--ink-strong);
  font-size: 12px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast);
}

.quick-btn:hover {
  background: rgba(0, 0, 0, 0.08);
}

.quick-btn.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.quick-ico {
  color: var(--theme-color);
  flex: none;
}
</style>
