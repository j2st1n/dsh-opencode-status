/**
 * 目录入口垫片（仅用于测试调用方式，不是用例文件）。
 *
 * Node 22.23 的 `node --test <dir>` 不再展开目录参数，而是把目录当作入口交给模块解析；
 * 目录解析需要 index.js，因此这里在「以目录为入口」时转去执行真正的用例文件。
 *
 * `node --test` 的自动发现会把 test/ 目录下的文件逐个当作用例文件执行，此时
 * process.argv[1] 是具体文件路径（以 .js 结尾），本文件不重复导入，避免用例跑两遍。
 */
const entry = process.argv[1] ?? ''
if (!/\.(?:js|mjs|cjs)$/.test(entry)) {
  await import('./index.test.js')
}
