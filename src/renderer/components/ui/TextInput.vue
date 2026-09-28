<template>
  <input
    class="tinput"
    :type="type"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :min="min"
    :max="max"
    :class="{ mono }"
    @input="$emit('update:modelValue', coerce($event.target.value))"
  />
</template>

<script setup>
const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  type: { type: String, default: 'text' },
  placeholder: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  numeric: { type: Boolean, default: false },
  /*
    允许小数。默认 false：numeric 字段绝大多数是"个数/毫秒/端口"，
    按整数清洗可以挡住 3.7 个端口这种非法值。
    但 Temperature 这类**本来就该是小数**的字段必须显式打开它 ——
    否则 0.75 会被静默截断成 0，用户看不出任何异常，
    点「应用」却把 0 写进配置文件（真实故障，见 coerce 注释）。
  */
  allowFloat: { type: Boolean, default: false },
  mono: { type: Boolean, default: false },
  /*
    可选范围（仅 numeric 生效）。给出后组件会把超范围的值夹到边界，
    避免端口 99999、超时 0、重启上限 -5 这类会被**原样落盘**的非法值。
    不传则不做范围限制（保持向后兼容）。
  */
  min: { type: Number, default: undefined },
  max: { type: Number, default: undefined }
});

defineEmits(['update:modelValue']);

/*
  数值清洗。
  原实现：Number.isNaN(n) 时**把原始字符串写进模型**，
  于是 '-'、'1e'、'  ' 这类中间态会一路存进设置文件，
  下次启动时后端拿到非法值，只能以"端口未就绪"之类的间接症状暴露。
  现在：
    空串        → 保留 ''（允许清空后重新输入，不强行塞 0）
    无法解析    → 保留上一次的合法值（不写入垃圾）
    超范围      → 夹到 min/max
    非整数      → 按整数处理，除非开了 allowFloat

  ⚠️ 关于 allowFloat（这是一个真实故障修出来的开关）：
    之前这里无条件 Math.trunc(n)，而设置页给 Temperature 也传了 numeric。
    结果是输入 0.75 → 界面显示 0；1.5 → 1；0.3 → 0。
    用户只是"改个温度"，界面不报错、也没有提示，
    点「应用」就把 temperature: 0 落盘了 —— 属于静默改坏配置。
    主进程 settings.js:59 那边用的是 clampNumber（保留小数，范围 0–2），
    本来就是对的，错的只有渲染层这一处取整。
    所以小数字段必须传 allow-float，并且把 min/max 对齐后端范围，
    避免界面允许输入一个后端会悄悄改掉的值。
*/
function coerce(raw) {
  if (!props.numeric) return raw;
  if (raw === '') return '';
  const n = Number(raw);
  if (Number.isNaN(n) || !Number.isFinite(n)) return props.modelValue;
  let v = props.allowFloat ? n : Math.trunc(n);
  if (typeof props.min === 'number' && v < props.min) v = props.min;
  if (typeof props.max === 'number' && v > props.max) v = props.max;
  return v;
}
</script>

<style scoped>
/*
  输入框的底原来是写死的 rgba(255,255,255,.9)：设置页有 20 个输入框，
  深色主题下就是 20 块糊脸的白色长条（用户"一大堆问题"里最扎眼的一类）。
  改走 token：--surface-2 在浅色是 #fbfcfe、深色是 #23272d（比卡片亮一档的深底），
  两套主题各自成立；聚焦时再抬到 --surface-3，深浅都有"变亮了"的反馈。
*/
.tinput {
  letter-spacing: var(--ls-sm);
  width: 100%;
  height: 32px;
  padding: 0 0.75rem;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  font-size: 12px;
  color: var(--ink-strong);
  outline: none;
  transition: border-color var(--dur-base), box-shadow var(--dur-base), background var(--dur-base);
}

.tinput.mono {
  letter-spacing: var(--ls-sm);
  font-family: Consolas, 'Cascadia Mono', monospace;
  font-size: 12px;
}

.tinput::placeholder {
  color: var(--ink-faint);
}

.tinput:focus {
  border-color: var(--theme-line);
  background: var(--surface-3);
  box-shadow: 0 0 0 2.5px var(--theme-tint);
}

/*
  禁用态（关于页的「运行环境」三个只读框走的就是这里）。
  原来只压 opacity .55：深色下等于把深底和浅字一起糊掉，读到一半的字忽明忽暗，
  而且 opacity 会连边框一起变淡，看不出"这是只读框"。

  ⚠️ 文字色既不用 --text-disabled，也不用 --ink-soft：
    · --text-disabled 在深色卡上只有 2.6:1，等于把数据藏起来；
    · --ink-soft 叠在 --fill-disabled 上实测浅色只有 4.47:1（叠底会把对比度再吃掉一点），
      差 0.03 不过 AA。
  这三个框里放的是**用户要看的信息**（版本 / 平台 / 数据目录），必须能读，
  所以直接给 --ink（浅色 8.2:1、深色 11:1）；"不可编辑"这层语义交给
  凹陷底（--fill-disabled）+ not-allowed 光标去表达，不靠把字调灰。
*/
.tinput:disabled {
  background: var(--fill-disabled);
  color: var(--ink);
  cursor: not-allowed;
}
</style>
