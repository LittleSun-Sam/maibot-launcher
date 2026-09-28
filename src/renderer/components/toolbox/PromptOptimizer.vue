<template>
  <div class="opt">
    <div class="opt-left">
      <div class="opt-head">
        <h3>生成输入</h3>
        <p>输入越接近真实需求，模型越容易拆解成可维护配置。</p>
      </div>

      <div class="field">
        <label>生成模型</label>
        <select v-model="model" class="sel">
          <option value="" disabled>{{ models.length ? '选择模型' : '无可用模型（请检查模型目录）' }}</option>
          <option v-for="m in models" :key="m.name" :value="m.name">{{ m.name }}</option>
        </select>
        <span v-if="modelsSource" class="model-src">
          {{ modelsSource === 'api' ? '来自后端 /v1/models' : '来自本地模型目录' }}
        </span>
      </div>

      <div class="field-row">
        <div class="field">
          <label>目标场景</label>
          <select v-model="scene" class="sel">
            <option v-for="s in SCENES" :key="s" :value="s">{{ s }}</option>
          </select>
        </div>
        <div class="field">
          <label>生成语言</label>
          <select v-model="lang" class="sel">
            <option v-for="l in LANGS" :key="l" :value="l">{{ l }}</option>
          </select>
        </div>
      </div>

      <div class="field">
        <div class="field-label-row">
          <label>原始人设 / 角色卡</label>
          <span class="char-count">{{ rawPrompt.length }}/20000</span>
        </div>
        <textarea
          v-model="rawPrompt"
          rows="7"
          class="ta"
          placeholder="输入描述你的人设、角色卡、对话风格等…"
        ></textarea>
      </div>

      <div class="field">
        <label>额外要求</label>
        <textarea
          v-model="extraReq"
          rows="3"
          class="ta"
          placeholder="例如：更短、更日常；不要攻击性；保留技术细节；不要改动角色口吻。"
        ></textarea>
      </div>

      <div class="field">
        <div class="field-label-row">
          <label>温度</label>
          <span class="val">{{ Number(temp).toFixed(1) }}</span>
        </div>
        <input v-model.number="temp" type="range" min="0.1" max="1.5" step="0.1" class="range" />
      </div>

      <div class="field">
        <div class="field-label-row">
          <label>最大输出 Token</label>
          <span class="val">{{ maxTokens }}</span>
        </div>
        <input v-model.number="maxTokens" type="range" min="200" max="4000" step="100" class="range" />
      </div>

      <PillButton
        v-if="loading"
        variant="danger"
        icon="stop"
        class="gen-btn"
        @click="stopGenerating"
      >
        中止生成
      </PillButton>
      <PillButton
        v-else
        variant="solid"
        icon="wand"
        class="gen-btn"
        @click="generate"
      >
        生成优化提示词
      </PillButton>

      <div class="presets">
        <h4>已保存人设</h4>
        <!--
          本地存储告警：配额写满或数据损坏时唯一的可见出口。
          没有它时"保存成功"的提示与实际的静默丢弃完全对不上。
        -->
        <div v-if="presetAlert" class="preset-alert" role="alert">
          <IconGlyph name="info" />
          <span>{{ presetAlert }}</span>
        </div>
        <p v-if="savedPresets.length === 0">还没有保存的人设</p>
        <div v-else class="preset-list">
          <div
            v-for="p in savedPresets"
            :key="p.id"
            class="preset-item"
            @click="loadPreset(p.id)"
          >
            <span class="preset-name">{{ p.name }}</span>
            <button
              type="button"
              class="preset-del"
              title="删除"
              @click.stop="deletePreset(p.id)"
            >
              <IconGlyph name="trash" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="opt-right">
      <div class="opt-right-top">
        <h3>生成结果</h3>
        <div class="top-actions">
          <PillButton variant="ghost" size="sm" icon="copy" :disabled="!blocks.length" @click="copyAll">
            全部复制
          </PillButton>
          <PillButton variant="ghost" size="sm" icon="save" :disabled="!blocks.length" @click="savePreset">
            保存人设
          </PillButton>
        </div>
      </div>

      <div class="out-tabs">
        <button
          v-for="(t, i) in outTabList"
          :key="t"
          type="button"
          class="out-tab"
          :class="{ on: outTab === i }"
          @click="outTab = i"
        >{{ t }}</button>
      </div>

      <div ref="outRef" class="out-body">
        <div v-if="loading" class="out-loading">
          <div v-if="reasoningText" class="stream-block">
            <div class="stream-head"><LoadingSpinner /><span class="think">思考过程</span></div>
            <div ref="reasoningRef" class="stream-text mono" @scroll="onReasoningScroll">{{ reasoningText }}</div>
          </div>
          <div v-if="streamingText" class="stream-block gen">
            <div class="stream-head"><span class="gen-tag">生成中</span></div>
            <div ref="streamRef" class="stream-text" @scroll="onStreamScroll">{{ streamingText }}</div>
          </div>
          <div v-if="!reasoningText && !streamingText" class="wait">
            <LoadingSpinner size="md" />
            <p>模型思考中，请稍候…</p>
          </div>
        </div>

        <template v-else-if="outTab === 0">
          <div v-if="!blocks.length" class="placeholder">左侧填好内容后点「生成」，这里会显示拆解好的配置块</div>
          <div v-else class="block-list">
            <div v-for="b in blocks" :key="b.key" class="block">
              <div class="block-head">
                <div class="block-title">
                  <span class="block-bar" />
                  <b>{{ b.label }}</b>
                </div>
                <PillButton variant="plain" size="sm" icon="copy" @click="copy(b.content, b.label)">复制</PillButton>
              </div>
              <p class="block-desc">{{ b.description }}</p>
              <div class="block-pre mono">
                <span class="block-key">{{ '{' + b.key + '}' }}</span>
                {{ b.content }}
              </div>
            </div>
          </div>
        </template>

        <template v-else-if="outTab === 1">
          <div v-if="!blocks.length" class="placeholder">生成后这里会显示纯文本片段</div>
          <div v-else class="snippet-list">
            <div v-for="b in blocks" :key="b.key" class="snippet">
              <div class="snippet-head">
                <b>{{ b.label }}</b>
                <button type="button" class="preset-del" title="复制" @click="copy(b.content, b.label)">
                  <IconGlyph name="copy" />
                </button>
              </div>
              <div class="snippet-pre mono">{{ b.content }}</div>
            </div>
          </div>
        </template>

        <template v-else>
          <div v-if="!rawOutput" class="placeholder">生成后这里会显示模型完整原始输出</div>
          <div v-else class="raw-pre mono">{{ rawOutput }}</div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import IconGlyph from '../IconGlyph.vue';
import PillButton from '../ui/PillButton.vue';
import LoadingSpinner from '../ui/LoadingSpinner.vue';
import { toast } from '../../composables/useToast.js';
import { abortLlm, listModels, streamChat } from '../../stores/app-store.js';

const SAVED_PROMPTS_KEY = 'maibot_saved_prompt_presets';

const SCENES = ['闲聊', '角色扮演', '问答', '代码辅助', '创作'];
const LANGS = ['简体中文', '繁体中文', 'English', '日本語'];
const outTabList = ['配置块', '配置片段', '原始输出'];

const models = ref([]);
/** 模型列表来源（'api' | 'local' | 'none'） */
const modelsSource = ref('');
const model = ref('');
const scene = ref('角色扮演');
const lang = ref('简体中文');
const rawPrompt = ref('');
const extraReq = ref('');
const temp = ref(0.7);
const maxTokens = ref(1800);

const loading = ref(false);
/** 进行中的 LLM 请求 id（用于中止与事件隔离） */
const inflightId = ref('');
const blocks = ref([]);
const rawOutput = ref('');
const outTab = ref(0);
const reasoningText = ref('');
const streamingText = ref('');
const reasoningPinned = ref(true);
const streamPinned = ref(true);

const outRef = ref(null);
const reasoningRef = ref(null);
const streamRef = ref(null);

/*
  预设的本地持久化。
  原实现两个 catch 都是空的：读取失败静默清空、写入失败静默丢弃。
  localStorage 配额写满时用户毫无察觉，直到重启发现预设全没了。

  声明顺序有讲究：presetAlert 必须在 loadPresets() **被调用之前** 存在，
  否则 loadPresets 里对它的赋值会撞上 TDZ（const 不提升）直接抛错。
*/
const presetAlert = ref('');
let presetWriteBroken = false;

function loadPresets() {
  try {
    const raw = localStorage.getItem(SAVED_PROMPTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    /* 数据被改坏成非数组时必须回退，否则后面 .map/.find 全都会炸 */
    if (!Array.isArray(parsed)) {
      presetAlert.value = '本地预设数据格式异常，已忽略（原数据未被覆盖）。';
      return [];
    }
    return parsed;
  } catch (e) {
    console.warn('[PromptOptimizer] 读取本地预设失败', e);
    presetAlert.value = '本地预设已损坏，无法读取（原数据仍在磁盘上，未被覆盖）。';
    return [];
  }
}

/** 读取本地已保存的预设（必须在 presetAlert 之后调用） */
const savedPresets = ref(loadPresets());

function persistPresets() {
  try {
    localStorage.setItem(SAVED_PROMPTS_KEY, JSON.stringify(savedPresets.value));
    if (presetWriteBroken) {
      presetWriteBroken = false;
      presetAlert.value = '';
    }
  } catch (e) {
    const quota = /quota|exceed/i.test(e?.name || '') || /quota|exceed/i.test(e?.message || '');
    const msg = quota
      ? '本地存储已满，预设无法保存。请删除一些旧预设后重试。'
      : `预设保存失败：${e?.message || e}`;
    if (!presetWriteBroken || presetAlert.value !== msg) toast(msg, 'error', 6000);
    presetWriteBroken = true;
    presetAlert.value = msg;
  }
}

function onReasoningScroll(e) {
  reasoningPinned.value =
    e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight < 16;
}
function onStreamScroll(e) {
  streamPinned.value =
    e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight < 16;
}

async function followStream() {
  await nextTick();
  if (reasoningPinned.value && reasoningRef.value) {
    reasoningRef.value.scrollTop = reasoningRef.value.scrollHeight;
  }
  if (streamPinned.value && streamRef.value) {
    streamRef.value.scrollTop = streamRef.value.scrollHeight;
  }
}

function buildSystemPrompt() {
  const extra = extraReq.value.trim() ? `- 额外要求：${extraReq.value.trim()}` : '';
  return `你是一个 MaiBot 人设配置优化助手。用户会给你一个原始的人设/角色卡描述，你需要把它拆解成三个结构化配置块：

1. personality（人格设定）：角色的人格和身份设定，包括性格、身份背景等
2. behavior_style（行为风格）：何时参与聊天、如何观察局面、何时保持安静的行动准则
3. reply_style（表达风格）：说话的风格，包括句式、长度、语气、标点使用等

要求：
- 目标场景：${scene.value}
- 输出语言：${lang.value}
${extra}
- 每个配置块的内容要具体、可操作，不要泛泛而谈
- 保持角色的一致性和连贯性

请严格用以下 JSON 格式输出（不要输出任何其他内容，不要用 markdown 代码块包裹）：
{"personality":"人格设定内容","behavior_style":"行为风格内容","reply_style":"表达风格内容"}`;
}

function extractBlocks(result) {
  let parsed = {};
  let cleaned = String(result || '').trim();
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) cleaned = codeBlockMatch[1].trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      /*
        这里**故意**保持静默：模型输出不合 JSON 是常见情况（多一句解释、
        少一个引号），下面是专门为此准备的正则兜底。
        如果在这里弹提示，正常使用中会不停出现"解析失败"的噪音，
        而实际上用户已经拿到了可用的三段内容。仅留控制台线索备查。
      */
      console.debug('[PromptOptimizer] 结构化解析失败，改用正则兜底', e?.message || e);
    }
  }
  if (Object.keys(parsed).length === 0) {
    const keys = ['personality', 'behavior_style', 'reply_style'];
    for (const k of keys) {
      const re = new RegExp(`(?:["']?${k}["']?\\s*[:：]\\s*["'])([\\s\\S]*?)(?:["'])`, 'i');
      const m = String(result || '').match(re);
      if (m && m[1]) parsed[k] = m[1].trim();
    }
  }
  return [
    {
      key: 'personality',
      label: '人格设定',
      description: '写入 bot_config.toml 的 personality.personality，覆盖当前人格设定字段。',
      content: parsed.personality || String(result || '')
    },
    {
      key: 'behavior_style',
      label: '行为风格',
      description: '写入 bot_config.toml 的 personality.behavior_style，AI 自动学习行为风格。',
      content: parsed.behavior_style || ''
    },
    {
      key: 'reply_style',
      label: '表达风格',
      description: '写入 bot_config.toml 的 personality.reply_style，覆盖当前表达风格字段。',
      content: parsed.reply_style || ''
    }
  ].filter((b) => b.content.length > 0);
}

async function generate() {
  if (!rawPrompt.value.trim()) {
    toast('请先输入原始人设/角色卡', 'warn');
    return;
  }
  if (!model.value) {
    toast('请先选择一个模型', 'warn');
    return;
  }

  loading.value = true;
  blocks.value = [];
  rawOutput.value = '';
  reasoningText.value = '';
  streamingText.value = '';
  reasoningPinned.value = true;
  streamPinned.value = true;
  outTab.value = 0;

  /*
    关键修正：
      · 旧代码用裸 onLlmStream 监听，会把所有并发 LLM 请求（含 AI 对话页）
        的输出混进这里；现在经 store.streamChat 按 requestId 隔离。
      · 旧代码调用 callLlm 时**没有传 model**，左侧选的模型完全不生效，
        永远用设置页的默认模型 —— 下拉框是个摆设。
      · 补上中止能力。
  */
  const { requestId, promise } = streamChat(
    {
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        {
          role: 'user',
          content: `请把以下原始人设/角色卡拆解成三个配置块：\n\n${rawPrompt.value}`
        }
      ],
      model: model.value,
      temperature: temp.value,
      maxTokens: maxTokens.value
    },
    {
      onDelta: (chunk) => {
        streamingText.value += chunk;
        followStream();
      },
      onError: (err) => {
        toast('LLM 调用失败：' + (err?.message || err), 'error', 5000);
      }
    }
  );

  inflightId.value = requestId;

  try {
    const result = await promise;
    if (result) {
      blocks.value = extractBlocks(result);
      rawOutput.value = result;
      toast('生成完毕', 'success');
    } else if (!streamingText.value) {
      toast('模型没有返回内容', 'warn');
    }
  } finally {
    loading.value = false;
    inflightId.value = '';
  }
}

/** 中止生成 */
async function stopGenerating() {
  if (!inflightId.value) return;
  await abortLlm(inflightId.value);
  /* 保留已经流式收到的部分，作为「原始输出」供用户参考 */
  if (streamingText.value && !rawOutput.value) {
    rawOutput.value = streamingText.value;
    blocks.value = extractBlocks(streamingText.value);
  }
  toast('已中止生成', 'info');
}

async function copy(text, label = '内容') {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label}已复制到剪贴板`, 'success');
  } catch (_) {
    toast('复制失败', 'error');
  }
}

function copyAll() {
  copy(
    blocks.value.map((b) => `### ${b.label}\n\n${b.content}`).join('\n\n'),
    '全部配置'
  );
}

function savePreset() {
  if (!blocks.value.length) {
    toast('先生成结果再保存', 'warn');
    return;
  }
  const name = rawPrompt.value.trim().slice(0, 20) || '未命名人设';
  const preset = { id: Date.now().toString(), name, createdAt: Date.now() };

  /*
    先把**实体**写进去，再登记索引。
    原先顺序相反：索引（savedPresets）先写成功，真正的预设内容写失败被
    空 catch 吞掉，接着无条件 toast('人设已保存')。
    结果列表里多出一个永远加载不出来的条目，用户以为保存成功了。
  */
  try {
    localStorage.setItem(
      `prompt_preset_${preset.id}`,
      JSON.stringify({
        blocks: blocks.value,
        rawPrompt: rawPrompt.value,
        scene: scene.value,
        lang: lang.value,
        model: model.value
      })
    );
  } catch (e) {
    const quota = /quota|exceed/i.test(e?.name || '') || /quota|exceed/i.test(e?.message || '');
    toast(
      quota
        ? '本地存储已满，人设保存失败。请删除一些旧预设后重试。'
        : `人设保存失败：${e?.message || e}`,
      'error',
      6000
    );
    return;
  }

  savedPresets.value = [...savedPresets.value, preset];
  persistPresets();
  toast('人设已保存', 'success');
}

function deletePreset(id) {
  savedPresets.value = savedPresets.value.filter((p) => p.id !== id);
  persistPresets();
  try {
    localStorage.removeItem(`prompt_preset_${id}`);
  } catch (e) {
    /*
      删除失败要说出来：索引已经移除，实体还在磁盘上 ——
      下次保存时如果 id 恰好复用就会读到旧内容，属于真正的脏数据。
    */
    toast('预设已从列表移除，但本地数据未能删除：' + (e?.message || e), 'warn', 5000);
  }
}

function loadPreset(id) {
  try {
    const raw = localStorage.getItem(`prompt_preset_${id}`);
    if (!raw) {
      toast('该预设的本地数据已不存在', 'warn', 4000);
      return;
    }
    const data = JSON.parse(raw);
    rawPrompt.value = data.rawPrompt || '';
    scene.value = data.scene || '角色扮演';
    lang.value = data.lang || '简体中文';
    model.value = data.model || (models.value.length ? models.value[0].name : '');
    blocks.value = Array.isArray(data.blocks) ? data.blocks : [];
    outTab.value = 0;
    toast('人设已加载', 'success');
  } catch (e) {
    /* 原来这里是空 catch：点「加载」什么都不发生，也没有任何解释 */
    toast('人设加载失败：数据已损坏或无法解析', 'error', 5000);
    console.warn('[PromptOptimizer] 加载预设失败', e);
  }
}

onMounted(async () => {
  /*
    修正：preload 中不存在 getMaibotModels，旧调用必然抛错并被空 catch 吞掉，
    模型下拉框因此永远是「无可用模型」。现在走真实的 llm:models 通道。
  */
  const r = await listModels();
  models.value = (r.models || []).map((m) => ({
    name: typeof m === 'string' ? m : m.id || m.name
  }));
  modelsSource.value = r.source || '';
  if (models.value.length) model.value = models.value[0].name;
  if (!r.ok && r.message) toast(`获取模型列表失败：${r.message}`, 'warn', 4500);
});

onBeforeUnmount(() => {
  if (inflightId.value) abortLlm(inflightId.value);
});
</script>

<style scoped>
.opt {
  display: flex;
  gap: 0;
  min-height: 560px;
  border-radius: var(--radius-lg);
  background: var(--card-bg);
  border: 1px solid var(--line);
  overflow: hidden;
}

.mono {
  font-family: Consolas, 'Cascadia Mono', monospace;
}

.model-src {
  letter-spacing: var(--ls-2xs);
  font-size: 10px;
  color: var(--ink-faint);
  margin-top: 0.125rem;
}

.opt-left {
  width: 400px;
  flex: none;
  padding: 1.125rem;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  overflow-y: auto;
  max-height: 560px;
}

.opt-head h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-strong);
}

.opt-head p {
  letter-spacing: var(--ls-sm);
  margin: 0.25rem 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink-soft);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.field-row {
  display: flex;
  gap: 0.75rem;
}

.field-row .field {
  flex: 1;
}

.field label {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
}

.field-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.char-count {
  letter-spacing: var(--ls-2xs);
  font-size: 10px;
  color: var(--ink-faint);
}

.val {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  color: var(--ink-soft);
}

.sel {
  letter-spacing: var(--ls-sm);
  height: 32px;
  padding: 0 0.5rem;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--field-bg);
  font-size: 12px;
  color: var(--ink-strong);
  outline: none;
}

.sel:focus {
  border-color: var(--theme-line);
  box-shadow: 0 0 0 2.5px var(--theme-tint);
}

.ta {
  letter-spacing: var(--ls-sm);
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--field-bg);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink-strong);
  outline: none;
  resize: none;
  font-family: inherit;
}

.ta:focus {
  border-color: var(--theme-line);
  box-shadow: 0 0 0 2.5px var(--theme-tint);
}

.range {
  width: 100%;
  accent-color: var(--theme-color);
}

.gen-btn {
  margin-top: 0.25rem;
  justify-content: center;
}

.presets {
  padding-top: 0.75rem;
  border-top: 1px solid var(--line);
}

.presets h4 {
  letter-spacing: var(--ls-sm);
  margin: 0 0 0.25rem;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-strong);
}

/* 本地存储告警（配额写满 / 数据损坏） */
.preset-alert {
  letter-spacing: var(--ls-sm);
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0.5rem 0;
  padding: 0.5rem 0.5rem;
  border-radius: var(--radius-sm);
  font-size: 12px;
  line-height: 1.5;
  /* 文字用 ink 档：--err 是图形档（白底 4.38:1），压在同色淡底上只剩 3.82:1；
     --err-ink 实测 5.06:1（深色 5.55:1），与 DownloadPanel 同族写法一致。 */
  color: var(--err-ink);
  background: var(--err-tint);
}

.presets p {
  letter-spacing: var(--ls-sm);
  margin: 0;
  font-size: 12px;
  color: var(--ink-faint);
  text-align: center;
  padding: 0.75rem 0;
}

.preset-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.preset-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius-sm);
  background: var(--row-bg);
  border: 1px solid var(--line);
  cursor: pointer;
}

.preset-item:hover {
  background: var(--row-bg-hover);
}

.preset-name {
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

.preset-del {
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

.preset-del:hover {
  color: var(--danger);
}

.opt-right {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.opt-right-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1.125rem;
  border-bottom: 1px solid var(--line);
}

.opt-right-top h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-strong);
}

.top-actions {
  display: flex;
  gap: 0.5rem;
}

.out-tabs {
  display: flex;
  gap: 0.25rem;
  padding: 0.5rem 1.125rem 0;
  border-bottom: 1px solid var(--line);
}

.out-tab {
  letter-spacing: var(--ls-sm);
  border: none;
  background: transparent;
  padding: 0.5rem 0.75rem;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-soft);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -0.125rem;
}

.out-tab.on {
  color: var(--ink-strong);
  border-bottom-color: var(--theme-color);
}

.out-body {
  flex: 1;
  overflow-y: auto;
  padding: 1rem 1.125rem;
  min-height: 260px;
}

.out-loading {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.stream-block {
  padding: 0.75rem;
  border-radius: 10px;
  background: var(--overlay-tint);
  border: 1px solid var(--line);
  max-height: 300px;
  overflow-y: auto;
}

.stream-block.gen {
  background: var(--overlay-tint);
}

.stream-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.stream-head .think {
  letter-spacing: var(--ls-2xs);
  font-size: 10px;
  font-weight: 600;
  color: var(--ink-soft);
}

.gen-tag {
  letter-spacing: var(--ls-2xs);
  font-size: 10px;
  font-weight: 600;
  color: var(--theme-color);
}

.stream-text {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  white-space: pre-wrap;
  line-height: 1.6;
  color: var(--ink-strong);
}

.wait {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  height: 180px;
}

.wait p {
  letter-spacing: var(--ls-sm);
  margin: 0;
  font-size: 12px;
  color: var(--ink-soft);
}

.placeholder {
  letter-spacing: var(--ls-sm);
  margin: auto;
  padding: 2.125rem 0;
  text-align: center;
  font-size: 12px;
  color: var(--ink-faint);
}

.block-list,
.snippet-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.block {
  padding: 1rem;
  border-radius: 12px;
  background: var(--card-bg);
  border: 1px solid var(--line);
}

.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.625rem;
  margin-bottom: 0.5rem;
}

.block-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.block-title b {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  color: var(--ink-strong);
}

.block-bar {
  display: block;
  width: 4px;
  height: 14px;
  border-radius: 2px;
  background: var(--theme-color);
}

.block-desc {
  letter-spacing: var(--ls-2xs);
  margin: 0 0 0.5rem;
  font-size: 10px;
  line-height: 1.5;
  color: var(--ink-soft);
}

.block-pre {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  background: var(--overlay-tint);
  border-radius: 8px;
  padding: 0.75rem;
  white-space: pre-wrap;
  line-height: 1.6;
  color: var(--ink-strong);
}

.block-key {
  display: block;
  color: var(--theme-color);
  margin-bottom: 0.25rem;
  font-weight: 600;
}

.snippet {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.snippet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.snippet-head b {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  color: var(--ink-strong);
}

.snippet-pre {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  background: var(--overlay-tint);
  border: 1px dashed var(--line);
  border-radius: 8px;
  padding: 0.75rem;
  white-space: pre-wrap;
  line-height: 1.6;
  color: var(--ink-soft);
}

.raw-pre {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  background: var(--overlay-tint);
  border: 1px dashed var(--line);
  border-radius: 10px;
  padding: 1rem;
  white-space: pre-wrap;
  line-height: 1.6;
  color: var(--ink-soft);
}
</style>
