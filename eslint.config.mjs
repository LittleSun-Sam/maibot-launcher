/*
================================================================================
技术文档：eslint.config.mjs
职责：静态检查门禁（ESLint 9 flat config）。

为什么在此之前项目一个 linter 都没有：
    正因如此，"导入了却从未使用"、"声明了却从未读取"这类问题只能靠人肉翻
    一千多行的单文件组件去找。实际盘点出过真实案例（AppLayout 里 import 了
    ref 却从未调用；QuickActions 里 import 了 store 却只用于一句注释）。
    这些不会让构建失败，只会变成噪音，并掩盖真正的问题。

设计取舍：
  · 只开**能确证是缺陷**的规则，不做风格管制。
    风格规则（缩进、引号、分号）会产生成百上千条无意义告警，
    把真正的问题淹掉 —— 那正是"装了 linter 却没人看"的经典死法。
  · no-unused-vars 对 `_` 前缀与 rest 兄弟放行：这是项目里已有的、
    用来表示"有意忽略"的惯例。
  · 渲染层用浏览器全局；主进程/preload/scripts 用 Node 全局；分开配置。
================================================================================
*/
import js from '@eslint/js';
import vue from 'eslint-plugin-vue';
import globals from 'globals';

/** 对所有源码都适用的"真缺陷"规则 */
const baseRules = {
  ...js.configs.recommended.rules,

  /* 未使用变量/导入 —— 本次引入 linter 的主要动因 */
  'no-unused-vars': [
    'error',
    {
      args: 'after-used',
      /* 惯例：以下划线开头表示"有意保留但暂不使用" */
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrors: 'none',
      /* 解构时允许用 rest 兄弟省略属性：const { a, ...rest } = obj */
      ignoreRestSiblings: true
    }
  ],

  /* 未定义就使用 —— 打错变量名时立刻暴露，而不是等到运行时白屏 */
  'no-undef': 'error',

  /* 重复声明 / 重复的 case 标签 */
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-duplicate-case': 'error',

  /* 不可达代码与无效判断 */
  'no-unreachable': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',

  /*
    空代码块。
    允许 catch 块为空（`catch (_) {}` 在"确实可以忽略"的场景是被接受的，
    本项目里剩余的几处都写了明确注释说明为什么可以忽略），
    但**函数体为空**通常是漏写实现，要报出来。
  */
  'no-empty': ['error', { allowEmptyCatch: true }],

  /* 在生产代码里留调试语句 */
  'no-debugger': 'error'
};

export default [
  /* ---------------- 忽略产物、第三方与考古层 ---------------- */
  {
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      /* build/ 全部 12 个文件都由 scripts/gen-icons.mjs 生成（见 package.json prebuild:main） */
      'build/**',
      'THIRD_PARTY_NOTICES/**',

      /*
        以下是"考古层"，不是可维护源码，必须排除在 lint 范围之外：
        · backup/          —— 两份完整旧源码快照（625 文件 / 30MB），
                              它们里面同样有 src/main/services/github.js，
                              lint 会对着**过期副本**报 unused eslint-disable。
        · patch-v1-gate/   —— 8 个一次性源码改写器（硬编码本机绝对路径）。
        · scripts/legacy/  —— 归档的历史探针（见 scripts/legacy/README.md）。
        · docs/**          —— 文档与审计产物（截图/json/日志），不是代码。

        为什么"排除"而不是"逐一修好"：这些目录要么是快照（修好也没有意义，
        下次重放补丁又会变回去），要么是已归档的一次性脚本（按定义不会再改）。
        把它们纳入门禁的直接后果是 `npm run lint` 恒红 —— 而 lint 是
        `npm run verify` 的第 1 步，等于整条门禁从第一步就失效。
      */
      'backup/**',
      'patch-v1-gate/**',
      'scripts/legacy/**',
      'docs/**',

      /*
        scripts/_tmp-* / _probe-dump.txt：临时探针（用完整批、用完即弃）。
        它们天然是"写到一半"的状态，把门禁绑在它们身上等于让 lint 随人手
        实时变红 —— 而 lint 是 `npm run verify` 的第 1 步。要临时验一个脚本
        请用 `npx eslint scripts/_tmp-xxx.mjs` 单点跑，不要靠全局门禁兜。
      */
      'scripts/_tmp-*',
      'scripts/_probe-dump.txt'
    ]
  },

  /* ---------------- 渲染层：浏览器环境 + Vue SFC ---------------- */
  {
    files: ['src/renderer/**/*.{js,vue}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        /*
          Vite / Electron preload 注入的三个桥（见 src/preload/preload.js:267-274）。
          使用选择是"补齐"而不是"删掉这条无效配置"：渲染层目前统一走
          `window.maibotApi` / `window.maibotEvents` / `window.launcher`
          （app-store.js、main.js、recover.js），所以 no-undef 抓不到裸写这三个
          名字的情况；把它们声明为 readonly 是为了让"漏写 window. 前缀"这种
          笔误仍然能被 no-undef 抓到，同时保留这层契约的自文档作用。
        */
        maibotApi: 'readonly',
        maibotEvents: 'readonly',
        launcher: 'readonly'
      }
    },
    plugins: { vue },
    processor: vue.processors['.vue'],
    rules: baseRules
  },

  /* ---------------- Vue 单文件组件 ---------------- */
  ...vue.configs['flat/recommended'].map((c) => ({    ...c,
    files: ['src/renderer/**/*.vue'],
    rules: {
      ...c.rules,
      ...baseRules,
      /*
        模板里的变量由 <script setup> 提供，ESLint 单看模板会误报未定义。
        vue 插件的处理器已经处理了这一点，这里只关掉与风格强相关的项。
      */
      'vue/multi-word-component-names': 'off',
      /* 属性换行/顺序属于风格，不纳入门禁 */
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/attributes-order': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/attribute-hyphenation': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/html-closing-bracket-spacing': 'off',
      'vue/html-quotes': 'off',
      'vue/mustache-interpolation-spacing': 'off',
      'vue/no-multi-spaces': 'off',
      /*
        真正有价值的模板规则：组件未使用（import 了却没在模板里用）、
        v-for 缺 key、prop 拼写等。
      */
      'vue/no-unused-components': 'error',
      'vue/require-v-for-key': 'error',
      'vue/no-use-v-if-with-v-for': 'error',
      'vue/no-parsing-error': 'error',
      'vue/no-mutating-props': 'error',
      'vue/no-dupe-keys': 'error',
      'vue/valid-v-for': 'error',
      'vue/valid-v-if': 'error',
      'vue/valid-template-root': 'error',

      /*
        ★ 这条是加 lint 门禁的首要目的之一。
        模板里引用了 <script setup> 中不存在的属性时，Vue **既不报错也不警告**，
        表现为"点了按钮什么都不会发生"——最耗时间的一类故障。
        实例：InstallerPanel 里模板写 @click="doInstallMaiBot"，
        而函数名是 doInstallMaibot（大小写不同），「安装 MaiBot」按钮
        因此完全失效且毫无提示。这条规则能直接抓出来。
      */
      'vue/no-undef-properties': 'error',
      /* 同理：模板里用了未注册的组件 */
      'vue/no-undef-components': ['error', { ignorePatterns: ['^router-', '^Transition$', '^TransitionGroup$'] }]
    }
  })),

  /*
    IconGlyph 的 v-html 豁免。
    该组件的 markup 取自文件内 ICONS 静态字典（本项目手写的 SVG 子元素），
    name 只用于查表、查不到就回退默认图标，用户输入永远不会进入 markup ——
    因此这里不存在 XSS 面。用配置层豁免而不是模板里的注释：
    模板中的 HTML 注释**不是**有效的 ESLint 指令，会被 --fix 直接删掉。
  */
  {
    files: ['src/renderer/components/IconGlyph.vue'],
    rules: { 'vue/no-v-html': 'off' }
  },

  /*
    AppLayout 标题栏图标的同类豁免（UI v3：自绘标题栏）。
    理由与上面完全相同：markup 来自本文件内的 ICONS 静态字典
    （最小化/最大化/还原/关闭/日/月/星/下拉箭头），没有任何用户输入
    进入 v-html，不存在 XSS 面。
    为什么不复用 IconGlyph：那是**共享**组件，本次 UI 改造是多人并行，
    在共享组件里加形状容易与其它责任区互相覆盖。
  */
  {
    files: ['src/renderer/components/AppLayout.vue'],
    rules: { 'vue/no-v-html': 'off' }
  },

  /* ---------------- 主进程 / preload：Node + Electron ---------------- */
  {
    files: ['src/main/**/*.js', 'src/preload/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      /* 这些文件是 CJS 源码（由 esbuild 打包为 .cjs） */
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        /* sandbox 化的 preload 里 process.contextIsolated 等由 Electron 提供 */
        process: 'readonly'
      }
    },
    rules: {
      ...baseRules,
      /* 主进程里 require 是正常的；未使用导入仍要报 */
      'no-undef': 'error'
    }
  },

  /* ---------------- 构建脚本：ESM + Node ---------------- */
  {
    files: ['scripts/**/*.mjs', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node
    },
    rules: baseRules
  }
];
