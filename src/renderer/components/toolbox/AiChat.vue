<template>
  <div class="chat">
    <!--
      本地存储告警（配额写满 / 存储被禁用 / 历史数据损坏）。
      这是持久失败**唯一**的可见出口 —— 没有它时用户会一直以为
      对话已经保存，直到重启应用发现全部丢失。
    -->
    <div v-if="storageAlert" class="chat-storage-warn" role="alert">
      <IconGlyph name="info" />
      <span>{{ storageAlert }}</span>
      <button type="button" class="csw-close" aria-label="关闭此提示" @click="storageAlert = ''">
        <IconGlyph name="close" />
      </button>
    </div>

    <!--
      左右两栏包在一个内层容器里：
      .chat 本身是横向 flex，横幅若直接作为它的子元素会变成左侧一整列。
    -->
    <div class="chat-cols">
      <div class="chat-side">
      <PillButton variant="ghost" size="sm" icon="refresh" @click="createSession">新建会话</PillButton>

      <div v-if="sessions.length === 0" class="side-empty">暂无会话，点击上方新建</div>

      <div v-else class="side-list">
        <div
          v-for="s in sortedSessions"
          :key="s.id"
          class="side-item"
          :class="{ active: s.id === activeId }"
          @click="activeId = s.id"
        >
          <IconGlyph :name="s.modelType === 'maibot' ? 'bot' : 'link'" class="side-ico" />
          <span class="side-title">{{ s.title }}</span>
          <button
            type="button"
            class="side-del"
            title="删除会话"
            @click.stop="onRequestDelete(s.id)"
          >
            <IconGlyph name="trash" />
          </button>
        </div>
      </div>
    </div>

    <div class="chat-main">
      <template v-if="activeSession">
        <div class="chat-top">
          <div class="chat-top-main">
            <IconGlyph :name="activeSession.modelType === 'maibot' ? 'bot' : 'link'" class="chat-top-ico" />
            <span class="chat-top-title">{{ activeSession.title }}</span>
            <span class="chat-badge">{{ activeSession.modelType === 'maibot' ? 'MaiBot' : '自接入' }} · {{ activeSession.modelName || '未选择' }}</span>
          </div>
          <PillButton variant="ghost" size="sm" icon="sliders" @click="showSettings = !showSettings">配置</PillButton>
        </div>

        <div class="chat-settings" :class="{ open: showSettings }">
          <div v-show="showSettings" class="chat-settings-inner">
            <div class="setting-row">
              <span class="setting-label">模型来源</span>
              <span class="seg">
                <button
                  type="button"
                  :class="['seg-btn', { on: activeSession.modelType === 'maibot' }]"
                  @click="switchType('maibot')"
                >MaiBot 模型</button>
                <button
                  type="button"
                  :class="['seg-btn', { on: activeSession.modelType === 'custom' }]"
                  @click="switchType('custom')"
                >自接入模型</button>
              </span>
            </div>

            <div v-if="activeSession.modelType === 'maibot'" class="setting-row">
              <span class="setting-label">模型</span>
              <select v-model="activeSession.modelName" class="sel">
                <option v-for="m in models" :key="m.name" :value="m.name">{{ m.name }}</option>
              </select>
              <span v-if="!models.length" class="hint">无可用模型（请检查模型目录）</span>
            </div>

            <template v-else>
              <div class="setting-row">
                <span class="setting-label">base_url</span>
                <TextInput v-model="activeSession.baseUrl" placeholder="https://api.openai.com/v1" />
              </div>
              <div class="setting-row">
                <span class="setting-label">api_key</span>
                <TextInput v-model="activeSession.apiKey" type="password" placeholder="可留空（本地 Ollama 免 key）" />
              </div>
              <div class="setting-row">
                <span class="setting-label">模型标识</span>
                <TextInput v-model="activeSession.modelName" placeholder="如 gpt-4o / qwen2.5" />
              </div>
            </template>

            <div class="setting-block">
              <span class="setting-label">系统提示词</span>
              <textarea v-model="activeSession.systemPrompt" rows="3" class="ta"></textarea>
            </div>

            <div class="setting-row">
              <span class="setting-label">温度</span>
              <input
                type="range"
                v-model.number="activeSession.temperature"
                min="0.1"
                max="1.5"
                step="0.1"
                class="range"
              />
              <span class="range-val">{{ Number(activeSession.temperature).toFixed(1) }}</span>
            </div>
            <div class="setting-row">
              <span class="setting-label">最大 Token</span>
              <input
                type="range"
                v-model.number="activeSession.maxTokens"
                min="200"
                max="4000"
                step="100"
                class="range"
              />
              <span class="range-val">{{ activeSession.maxTokens }}</span>
            </div>
          </div>
        </div>

        <div ref="msgRef" class="chat-msgs" @scroll="onMsgScroll">
          <div v-if="activeSession.messages.length === 0" class="msgs-empty">
            <IconGlyph name="bot" class="msgs-empty-ico" />
            <p>开始一段对话吧</p>
          </div>

          <template v-else>
            <div
              v-for="m in activeSession.messages"
              :key="m.id"
              class="msg"
              :class="m.role"
            >
              <span v-if="m.role === 'assistant'" class="avatar"><IconGlyph name="bot" /></span>

              <div class="msg-body">
                <div
                  v-if="m.reasoning || (sending && !m.content && m.id === sendingId)"
                  class="reasoning"
                >
                  <button
                    type="button"
                    class="reasoning-toggle"
                    @click="toggleReasoning(m.id)"
                  >
                    <IconGlyph :name="expanded[m.id] ? 'chev-up' : 'chev-down'" />
                    {{ sending && !m.reasoning && m.id === sendingId ? '思考中…' : '思考过程' }}
                  </button>
                  <div class="reasoning-panel" :class="{ open: expanded[m.id] }">
                    <div v-show="expanded[m.id]" class="reasoning-text">{{ m.reasoning || '正在深度思考中…' }}</div>
                  </div>
                </div>

                <div class="bubble">
                  {{ m.content || (sending && m.id === sendingId ? '思考中…' : '（空）') }}
                </div>
              </div>

              <span v-if="m.role === 'user'" class="avatar user"><IconGlyph name="grid" /></span>
            </div>
          </template>
        </div>

        <div class="chat-input">
          <textarea
            v-model="input"
            rows="1"
            class="input"
            placeholder="输入消息，Enter 发送，Shift+Enter 换行…"
            @keydown="onKeydown"
          ></textarea>

          <!-- 生成中显示「停止」：旧实现没有任何中止手段，只能等或刷新 -->
          <PillButton
            v-if="sending"
            variant="danger"
            icon="stop"
            icon-only
            title="中止生成"
            @click="stopGenerating"
          >停止</PillButton>
          <PillButton
            v-else
            variant="solid"
            icon="check"
            icon-only
            :disabled="!input.trim()"
            title="发送"
            @click="send"
          >发送</PillButton>
        </div>
      </template>

      <div v-else class="chat-welcome">
        <IconGlyph name="chat" class="welcome-ico" />
        <p class="welcome-title">AI 对话</p>
        <p class="welcome-sub">左侧新建会话，选择 MaiBot 模型或自接入模型，配置系统提示词后即可开始对话。</p>
      </div>
    </div>
    </div><!-- /.chat-cols -->

    <!--
      模态框保持为 .chat 的直接子元素，才能覆盖整个面板。
      这里原来**没有任何过渡**（弹窗是硬闪出来的），现在与全项目二级窗口统一：
      --dur-base(180ms) + --ease-standard，遮罩淡入淡出 + 面板轻微上浮/缩放。
      :css="animOk" 是窗口不可见时的保命开关，理由见 OverviewPanel.vue 里
      「过渡的保命开关」一节的实测记录（隐藏窗口没有帧，离场会收不了尾）。
    -->
    <Transition name="dlg" :css="animOk">
      <div v-if="deleteTarget" class="modal-mask">
        <div class="modal">
          <h4>删除会话</h4>
          <p>确定要删除这个会话吗？此操作不可恢复。</p>
          <div class="modal-actions">
            <PillButton variant="ghost" size="sm" @click="deleteTarget = null">取消</PillButton>
            <PillButton variant="danger" size="sm" @click="confirmDelete">删除</PillButton>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import IconGlyph from '../IconGlyph.vue';
import PillButton from '../ui/PillButton.vue';
import TextInput from '../ui/TextInput.vue';
import { toast } from '../../composables/useToast.js';
import { abortLlm, listModels, store, streamChat } from '../../stores/app-store.js';

const SESSIONS_KEY = 'maibot_chat_sessions';
const ACTIVE_KEY = 'maibot_chat_active_session';

/*
  渲染层的兜底超时（毫秒）。
  ──────────────────────────────────────────────────────────────────────
  为什么主进程已经有超时，这里还要再加一道：
    主进程 llm.js 的超时只能保证"fetch 会被 abort"。但 UI 的锁是在
    `await promise` 的 finally 里释放的，而这个 promise 来自
    `safeInvoke → ipcRenderer.invoke`。只要 IPC 本身没有 settle
    （主进程崩溃/重载、管道断开、handler 卡在别处），finally 就永远不会执行 ——
    输入框会被 sending 永久锁死，连「停止」按钮也救不回来。
  预算必须比主进程的"总时长上限"（llm.js: DEFAULT_TOTAL_TIMEOUT_MS = 10 分钟）
  更长，否则会在主进程正常收尾之前抢先把请求判死。
*/
const STREAM_UI_TIMEOUT_MS = 11 * 60 * 1000;

const genId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/*
  本地存储相关的状态（必须在 loadSessions 声明之前）。

  为什么要有 storageAlert：
    localStorage 在配额写满（对话历史会一直累积）或被禁用时会**抛异常**，
    原来的 persistSessions / persistActive 都是 `catch (_) {}` ——
    用户看到消息已经发出、界面一切正常，实际一条都没存下来，
    关掉应用才发现对话全没了。这里把它变成可见的界面告警。
*/
const storageAlert = ref('');
let storageBroken = false;
/** 读取本地会话时解析失败（数据损坏），与 storageBroken 是两回事 */
let readFailed = false;

function loadSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    /* 损坏或被人手改成非数组时必须回退，否则下面 reactive() 会拿到对象/字符串 */
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    /*
      读取失败要给用户一个可理解的信号，而不是静默清空。
      以前是 catch(_) { return [] } —— 历史记录一旦解析失败就"凭空消失"，
      用户会以为是自己删掉的。
    */
    console.warn('[AiChat] 读取本地会话失败', e);
    readFailed = true;
    return [];
  }
}

/* 把读取失败也纳入统一的告警文案（此时 storageAlert 已可用） */
if (readFailed) {
  storageAlert.value = '本地对话记录已损坏，无法读取（原数据仍在磁盘上，未被覆盖）。';
}

const sessions = reactive(loadSessions());
const activeId = ref(localStorage.getItem(ACTIVE_KEY) || '');
const models = ref([]);
/** 模型列表来源（'api' | 'local' | ''），用于提示用户 */
const modelsSource = ref('');
/** 进行中的 LLM 请求 id，用于中止 */
const inflightId = ref('');
const input = ref('');
const sending = ref(false);
const sendingId = ref('');
const showSettings = ref(false);
const expanded = reactive({});
const deleteTarget = ref(null);
const msgRef = ref(null);
const pinned = ref(true);

const activeSession = computed(() => sessions.find((s) => s.id === activeId.value) || null);
const sortedSessions = computed(() =>
  [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
);

/**
 * 持久化助手：失败时把问题真正暴露出来。
 * 原实现是 `catch (_) {}` —— 配额写满时用户完全无从得知，
 * 直到关掉应用发现所有对话都没了。
 * @param {string} what 用于提示的宾语
 * @param {() => void} fn 实际写入动作
 */
function persistOrWarn(what, fn) {
  try {
    fn();
    /* 之前失败过、这次成功了：清掉告警，避免一直挂着 */
    if (storageBroken) {
      storageBroken = false;
      storageAlert.value = '';
    }
  } catch (e) {
    const quota = /quota|exceed/i.test(e?.name || '') || /quota|exceed/i.test(e?.message || '');
    const msg = quota
      ? `本地存储已满，${what}无法保存。请删除一些旧会话后重试。`
      : `${what}保存失败：${e?.message || e}`;
    /* 只在状态变化时提示，避免每次按键都弹一条 */
    if (!storageBroken || storageAlert.value !== msg) {
      toast(msg, 'error', 6000);
    }
    storageBroken = true;
    storageAlert.value = msg;
  }
}

function persistSessions() {
  persistOrWarn('对话记录', () => localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions)));
}

function persistActive() {
  persistOrWarn('当前会话标记', () => localStorage.setItem(ACTIVE_KEY, activeId.value));
}

watch(sessions, persistSessions, { deep: true });
watch(activeId, persistActive);

function patchSession(id, patch) {
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  Object.assign(s, patch, { updatedAt: Date.now() });
}

function createSession() {
  const first = models.value.length ? models.value[0].name : '';
  const now = Date.now();
  const s = {
    id: genId(),
    title: `新会话 ${sessions.length + 1}`,
    modelType: first ? 'maibot' : 'custom',
    modelName: first || '',
    baseUrl: store.settings?.llm?.custom?.baseUrl || '',
    apiKey: store.settings?.llm?.custom?.apiKey || '',
    systemPrompt: '你是一个有帮助的 AI 助手。',
    temperature: 0.7,
    maxTokens: 2000,
    messages: [],
    createdAt: now,
    updatedAt: now
  };
  sessions.push(s);
  activeId.value = s.id;
  showSettings.value = false;
}

function switchType(type) {
  if (!activeSession.value) return;
  if (type === 'maibot') {
    patchSession(activeSession.value.id, {
      modelType: 'maibot',
      modelName: models.value.length ? models.value[0].name : ''
    });
  } else {
    patchSession(activeSession.value.id, { modelType: 'custom' });
  }
}

function onRequestDelete(id) {
  deleteTarget.value = id;
}

function confirmDelete() {
  if (deleteTarget.value) {
    const idx = sessions.findIndex((s) => s.id === deleteTarget.value);
    sessions.splice(idx, 1);
    if (activeId.value === deleteTarget.value) {
      activeId.value = sessions.length ? sessions[0].id : '';
    }
  }
  deleteTarget.value = null;
}

function toggleReasoning(id) {
  expanded[id] = !expanded[id];
}

function onMsgScroll(e) {
  const el = e.target;
  pinned.value = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
}

async function scrollBottom() {
  if (!pinned.value) return;
  await nextTick();
  const el = msgRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function buildMessages(session, userText) {
  const msgs = [];
  if (session.systemPrompt && session.systemPrompt.trim()) {
    msgs.push({ role: 'system', content: session.systemPrompt });
  }
  for (const m of session.messages) {
    if (m.content) msgs.push({ role: m.role, content: m.content });
  }
  msgs.push({ role: 'user', content: userText });
  return msgs;
}

async function send() {
  const text = input.value.trim();
  const s = activeSession.value;
  if (!text || !s || sending.value) return;

  if (s.modelType === 'custom') {
    if (!s.baseUrl?.trim()) {
      toast('请填写自定义接口 base_url', 'warn');
      return;
    }
    if (!s.modelName?.trim()) {
      toast('请填写自定义接口模型标识', 'warn');
      return;
    }
  }
  if (s.modelType === 'maibot' && !s.modelName) {
    toast('请先选择 MaiBot 模型', 'warn');
    return;
  }

  const userMsg = { id: genId(), role: 'user', content: text, createdAt: Date.now() };
  const aiMsg = { id: genId(), role: 'assistant', content: '', reasoning: '', createdAt: Date.now() };
  s.messages.push(userMsg, aiMsg);
  input.value = '';
  sending.value = true;
  sendingId.value = aiMsg.id;
  pinned.value = true;

  const messages = buildMessages(s, text);

  /*
    关键修正：改为走 store 的 streamChat。
    · 事件按 requestId 过滤 —— 旧实现用裸 onLlmStream 监听，会把**所有**
      LLM 请求（含另一个会话、提示词优化页）的输出全部灌进当前消息，
      并发时内容互相污染。
    · 拿到 requestId 后可以真正「中止」，旧实现没有任何中止手段。
  */
  const isCustom = s.modelType === 'custom';
  const params = isCustom
    ? {
        useCustom: true,
        messages,
        baseUrl: s.baseUrl.trim(),
        apiKey: s.apiKey?.trim(),
        model: s.modelName.trim(),
        temperature: s.temperature,
        maxTokens: s.maxTokens
      }
    : {
        messages,
        /* 旧实现漏传 model —— 用户在下拉框选的模型根本不会生效 */
        model: s.modelName,
        temperature: s.temperature,
        maxTokens: s.maxTokens
      };

  const { requestId, promise } = streamChat(params, {
    onDelta: (chunk) => {
      aiMsg.content += chunk;
      scrollBottom();
    },
    onError: (err) => {
      if (!aiMsg.content) {
        aiMsg.content = `⚠️ 调用失败：${err?.message || '未知错误'}`;
      }
      toast('LLM 调用失败：' + (err?.message || err), 'error', 5000);
    }
  });

  inflightId.value = requestId;

  /*
    兜底看门狗。
    ──────────────────────────────────────────────────────────────────
    这里**不能**只靠 `await promise`：safeInvoke 永不 reject，它的 promise
    只在 IPC 真正 settle 时才兑现；主进程一旦卡住/崩溃，这个 await 会永远
    挂在那里，下面的 finally 也就永远不执行 —— 界面上的表现就是
    "发送中"锁死（输入框不能发、按钮变「停止」）。
    所以用 Promise.race 挂一个独立的 deadline：超时后（1）主动 abort，
    （2）立刻让 await 返回，让 finally 一定跑完、锁一定释放。
    计时器在 finally 里清掉，正常路径不会留下悬挂的定时器。
  */
  let uiTimeoutId = null;
  const uiTimeout = new Promise((_, reject) => {
    uiTimeoutId = setTimeout(
      () => reject(new Error('界面等待 LLM 响应超时，已释放输入框并可重试')),
      STREAM_UI_TIMEOUT_MS
    );
  });

  try {
    await Promise.race([promise, uiTimeout]);
    if (s.messages.length === 2) {
      s.title = text.length > 20 ? text.slice(0, 20) + '…' : text;
    }
  } catch (e) {
    /*
      走到这里有两种可能：
        · 看门狗超时（IPC 没 settle）→ 请求可能还在主进程里跑，主动 abort，
          并明确告诉用户"可以重试"，而不是让界面看起来已经失败了却毫无提示。
        · promise 本身被拒（app-store 的参数校验失败路径）→ 只提示。
      注意：**不要**在这里覆盖 aiMsg.content —— 已经流式收到的内容要保留，
      用户至少还能看到半截回答。
    */
    const message = e?.message || String(e);
    if (inflightId.value) {
      Promise.resolve(abortLlm(inflightId.value)).catch(() => { /* 取消失败不影响释放 UI 锁 */ });
    }
    toast(`LLM 调用失败：${message}`, 'error', 6000);
  } finally {
    if (uiTimeoutId !== null) clearTimeout(uiTimeoutId);
    /* 三条路径（正常完成 / 中止 / 超时异常）都必须复位，这是 UI 锁的唯一释放点 */
    sending.value = false;
    sendingId.value = '';
    inflightId.value = '';
    scrollBottom();
  }
}

/** 中止当前进行中的请求 */
function stopGenerating() {
  if (!inflightId.value) return;
  /*
    这里刻意不 await：中止通道本身也可能卡住（那正是要看门狗兜底的场景）。
    发出去即可 —— 主进程收到 llm:abort 会 abort fetch，请求随即 settle，
    send() 的 finally 会释放锁；万一没 settle，还有看门狗兜底。
  */
  abortLlm(inflightId.value);
  toast('已中止生成', 'info');
}

function onKeydown(e) {
  /*
    输入法组合态必须放行。
    ──────────────────────────────────────────────────────────────────
    中文/日文输入时，回车是"确认候选词"，不是"发送"。
    原来只看 key==='Enter' 就直接 preventDefault + send()：
    用户打"你好"、候选框里选字按回车 → 消息被发出去，选中的字还没落进输入框。
    isComposing 是标准属性；部分 Windows 输入法（尤其中文）不上报它，
    只在 keydown 里给 keyCode 229，所以两个都要判。
  */
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

watch(
  () => activeSession.value?.messages.length,
  scrollBottom
);

/*
  过渡的"保命开关"（与 OverviewPanel.vue 同一套，理由见那里的实测记录）：
  窗口不可见时 Chromium 不产生帧，Vue 的 <Transition> 离场既等不到 transitionend
  也等不到 nextFrame()，弹窗会"关不掉"。所以隐藏时把 css 关掉（:css="animOk"），
  元素同步插入/移除；可见时照旧走 180ms 动画。
*/
const animOk = ref(true);
function syncAnimOk() {
  animOk.value = document.visibilityState === 'visible';
}

onMounted(async () => {
  syncAnimOk();
  document.addEventListener('visibilitychange', syncAnimOk);
  /*
    修正：preload 里从来没有 getMaibotModels 这个方法，
    旧代码调用必然抛错并被空 catch 吞掉，模型列表永远是空的。
    现在改用 store.listModels()，它走真实的 llm:models 通道，
    失败时回退到本地目录扫描并返回 message 供提示。
  */
  const r = await listModels();
  models.value = (r.models || []).map((m) => ({
    name: typeof m === 'string' ? m : m.id || m.name,
    label: typeof m === 'string' ? m : m.label || m.id || m.name
  }));
  modelsSource.value = r.source || '';
  if (!r.ok && r.message) {
    toast(`获取模型列表失败：${r.message}`, 'warn', 4500);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', syncAnimOk);
  /* 卸载时终止仍在进行的请求，避免回调写入已销毁的组件状态 */
  if (inflightId.value) abortLlm(inflightId.value);
});
</script>

<style scoped>
.chat {
  /* 纵向：顶部可选的存储告警条 + 下面的左右两栏 */
  display: flex;
  flex-direction: column;
  gap: 0;
  min-height: 560px;
  border-radius: var(--radius-lg);
  background: var(--card-bg);
  border: 1px solid var(--line);
  overflow: hidden;
}

/* 左右两栏容器（原来这两栏直接是 .chat 的子元素） */
.chat-cols {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

/* 本地存储告警条：这是持久失败唯一的可见出口，必须醒目 */
.chat-storage-warn {
  letter-spacing: var(--ls-sm);
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  font-size: 12px;
  line-height: 1.5;
  /* 文字用 ink 档：--err 是图形档（白底 4.38:1），压在同色淡底上只剩 3.82:1；
     --err-ink 实测 5.06:1（深色 5.55:1），与 DownloadPanel 同族写法一致。 */
  color: var(--err-ink);
  background: var(--err-tint);
  border-bottom: 1px solid var(--err-line);
}

.chat-storage-warn .csw-close {
  flex: none;
  margin-left: auto;
  display: inline-flex;
  padding: 0.125rem;
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  opacity: 0.7;
}

.chat-storage-warn .csw-close:hover {
  opacity: 1;
}

.chat-side {
  width: 240px;
  flex: none;
  padding: 0.75rem;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  overflow-y: auto;
  /*
    原来是 max-height: 560px（写死等于面板高度）。
    现在面板顶部可能多出一条存储告警，560px 会顶出容器并让左侧列表
    底部被裁掉；改成随容器收缩，两种情况下都不会溢出。
  */
  max-height: 100%;
}

.side-empty {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  color: var(--ink-faint);
  text-align: center;
  padding: 1.125rem 0;
}

.side-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.side-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.625rem;
  border-radius: var(--radius-sm);
  background: var(--row-bg);
  border: 1px solid transparent;
  cursor: pointer;
  transition: background var(--dur-base), border-color var(--dur-base);
}

.side-item:hover {
  background: var(--row-bg-hover);
}

.side-item.active {
  background: var(--theme-tint);
  border-color: var(--theme-line);
}

.side-ico {
  font-size: 13px;
  color: var(--theme-color);
  flex: none;
}

.side-title {
  letter-spacing: var(--ls-sm);
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.side-del {
  letter-spacing: var(--ls-sm);
  flex: none;
  border: none;
  background: transparent;
  color: var(--ink-faint);
  font-size: 12px;
  cursor: pointer;
  padding: 0.125rem;
  border-radius: 6px;
}

.side-del:hover {
  color: var(--danger);
}

.chat-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.chat-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.625rem;
  padding: 0.625rem 1rem;
  border-bottom: 1px solid var(--line);
}

.chat-top-main {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}

.chat-top-ico {
  letter-spacing: var(--ls-title);
  font-size: 15px;
  color: var(--theme-color);
  flex: none;
}

.chat-top-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-strong);
}

.chat-badge {
  letter-spacing: var(--ls-2xs);
  font-size: 10px;
  font-weight: 600;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  background: var(--overlay-tint);
  color: var(--ink-soft);
}

.chat-settings {
  overflow: hidden;
  max-height: 0;
  opacity: 0;
  transition: max-height var(--dur-slow) var(--ease), opacity var(--dur-slow) ease;
  background: var(--bar-bg);
}

.chat-settings.open {
  max-height: 600px;
  opacity: 1;
  border-bottom: 1px solid var(--line);
}

.chat-settings-inner {
  padding: 0.75rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.setting-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 28px;
}

.setting-label {
  letter-spacing: var(--ls-sm);
  flex: none;
  width: 72px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
}

.setting-block {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.seg {
  display: inline-flex;
  flex: 1;
  border-radius: var(--radius-sm);
  background: var(--seg-bg);
  border: 1px solid var(--line-strong);
  overflow: hidden;
}

.seg-btn {
  letter-spacing: var(--ls-sm);
  flex: 1;
  border: none;
  background: transparent;
  padding: 0.25rem 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-soft);
  cursor: pointer;
}

.seg-btn.on {
  background: var(--theme-color);
  color: var(--on-accent);
}

.sel {
  letter-spacing: var(--ls-sm);
  flex: 1;
  height: 30px;
  padding: 0 0.5rem;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--field-bg);
  font-size: 12px;
  color: var(--ink-strong);
  outline: none;
}

.hint {
  letter-spacing: var(--ls-2xs);
  font-size: 10px;
  color: var(--ink-faint);
}

.ta {
  letter-spacing: var(--ls-sm);
  width: 100%;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--field-bg);
  font-size: 12px;
  color: var(--ink-strong);
  outline: none;
  resize: none;
  line-height: 1.5;
}

.ta:focus {
  border-color: var(--theme-line);
  box-shadow: 0 0 0 2.5px var(--theme-tint);
}

.range {
  flex: 1;
  accent-color: var(--theme-color);
  height: 16px;
}

.range-val {
  letter-spacing: var(--ls-sm);
  flex: none;
  width: 40px;
  text-align: right;
  font-size: 12px;
  color: var(--ink-soft);
}

.chat-msgs {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-height: 200px;
  max-height: 320px;
}

.msgs-empty {
  margin: auto;
  text-align: center;
  color: var(--ink-faint);
}

.msgs-empty-ico {
  font-size: 28px;
  margin-bottom: 0.375rem;
  opacity: 0.6;
}

.msgs-empty p {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
}

.msg {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}

.msg.user {
  justify-content: flex-end;
}

.avatar {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--theme-tint);
  color: var(--theme-color);
  font-size: 13px;
}

.avatar.user {
  background: var(--ink-strong);
  color: var(--on-accent);
}

.msg-body {
  max-width: 75%;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.bubble {
  letter-spacing: var(--ls-sm);
  padding: 0.5rem 0.75rem;
  border-radius: 14px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg.user .bubble {
  background: var(--ink-strong);
  color: var(--on-accent);
  border-bottom-right-radius: 3px;
}

.msg.assistant .bubble {
  background: var(--card-bg);
  border: 1px solid var(--line);
  color: var(--ink-strong);
  border-bottom-left-radius: 3px;
}

.reasoning {
  width: 100%;
}

.reasoning-toggle {
  letter-spacing: var(--ls-2xs);
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  border: 1px solid var(--line);
  background: var(--field-bg);
  border-radius: 6px;
  padding: 0.125rem 0.5rem;
  font-size: 10px;
  color: var(--ink-soft);
  cursor: pointer;
}

.reasoning-toggle svg {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
}

.reasoning-panel {
  overflow: hidden;
  max-height: 0;
  opacity: 0;
  transition: max-height var(--dur-slow) ease, opacity var(--dur-base) ease;
}

.reasoning-panel.open {
  max-height: 240px;
  opacity: 1;
}

.reasoning-text {
  letter-spacing: var(--ls-sm);
  margin-top: 0.375rem;
  padding: 0.5rem 0.625rem;
  border-radius: 8px;
  background: var(--overlay-tint);
  border: 1px dashed var(--line);
  font-size: 12px;
  color: var(--ink-soft);
  line-height: 1.6;
  white-space: pre-wrap;
  font-family: Consolas, 'Cascadia Mono', monospace;
}

.chat-input {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 0.75rem;
  border-top: 1px solid var(--line);
}

.input {
  letter-spacing: var(--ls-sm);
  flex: 1;
  min-height: 40px;
  max-height: 120px;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--field-bg);
  font-size: 12px;
  color: var(--ink-strong);
  outline: none;
  resize: none;
  line-height: 1.5;
  font-family: inherit;
}

.input:focus {
  border-color: var(--theme-line);
  box-shadow: 0 0 0 2.5px var(--theme-tint);
}

.chat-welcome {
  margin: auto;
  text-align: center;
  padding: 3.75rem 1.25rem;
  color: var(--ink-faint);
}

.welcome-ico {
  font-size: 34px;
  color: var(--theme-color);
  opacity: 0.7;
}

.welcome-title {
  margin: 0.625rem 0 0.25rem;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-strong);
}

.welcome-sub {
  letter-spacing: var(--ls-sm);
  margin: 0 auto;
  max-width: 280px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-soft);
}

.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--modal-mask);
}

.modal {
  width: 300px;
  padding: 1.125rem;
  border-radius: var(--radius-lg);
  background: var(--card-bg);
  border: 1px solid var(--line);
  box-shadow: var(--modal-shadow);
}

.modal h4 {
  margin: 0 0 0.375rem;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-strong);
}

.modal p {
  letter-spacing: var(--ls-sm);
  margin: 0 0 0.875rem;
  font-size: 12px;
  color: var(--ink-soft);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

/*
  弹窗过渡：与全项目二级窗口统一 —— --dur-base(180ms) + --ease-standard。
  遮罩淡入淡出 + 面板轻微上浮/缩放，和 OverviewPanel 的 .picker-*、
  OnboardingWizard 的 .wiz-*、UpdateDialog 的自绘动画是同一套时长与缓动。
  修复前这里完全没有过渡（弹窗硬闪），是这几处里唯一"没动画"的一个。
*/
.dlg-enter-from,
.dlg-leave-to {
  opacity: 0;
}

.dlg-enter-from .modal,
.dlg-leave-to .modal {
  opacity: 0;
  transform: translateY(8px) scale(0.97);
}

.dlg-enter-active,
.dlg-leave-active {
  transition: opacity var(--dur-base) var(--ease-standard);
}

.dlg-enter-active .modal,
.dlg-leave-active .modal {
  transition:
    opacity var(--dur-base) var(--ease-standard),
    transform var(--dur-base) var(--ease-standard);
}
</style>
