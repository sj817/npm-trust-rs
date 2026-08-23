import lintspec from '@qwqo/eslint-config'

export default lintspec({
  node: true,
  typescript: true,
  // moduleResolution: Bundler(tsdown 打包发布)—— 相对导入一律不写扩展名
  importX: true,
  perfectionist: true,
  // menu/wizard 是交互流程主干，行数天然偏大；先不设行数闸
  maxLines: false,
  ignores: ['selftest/**'],
  overrides: {
    // 本包就是 CLI：入口/交互流程里 fail-fast 的 process.exit 是预期写法
    'unicorn/no-process-exit': 'off',
    // 类成员/模块顶层的字母序重排与 unicorn/consistent-class-member-order 冲突，
    // 且机械重排声明有初始化顺序语义,与 study 仓库同因同解
    'perfectionist/sort-classes': 'off',
    'perfectionist/sort-modules': 'off',
    // registry 写操作串行是刻意的:一次 OTP 在 5 分钟窗口内按包依次使用,
    // 并发会打乱交互提示顺序,也会放大限流风险
    'no-await-in-loop': 'off',
  },
})
