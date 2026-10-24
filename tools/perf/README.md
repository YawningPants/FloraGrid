# 日枝前端性能样本

运行 `node tools/perf/flowers.mjs`，使用独立 Chrome 用户目录，测试当前真实日视图代码与五种花朵渲染方式。

可选参数：`app`、`completion`、`field`、`legacy`。浏览器路径可以通过 `CHROME_PATH` 环境变量指定。采集结果位于 `src-tauri/target/perf-flowers-report*.json`。

- `app`：50 项任务、300 项含子任务、750 项含子任务；对可完成的叶子任务操作，验证完成数确实变化。
- `completion`：日枝外观开启开花，预热后测五次；分别记录点击到样式/布局提交的同步耗时，以及覆盖开花和归位的 800 ms 观察窗口内累计 Task、Script、Style/Layout 时间。800 ms 是观察窗口，不是操作耗时；累计任务时间也不是单帧阻塞时间。
- `field`：统一花型和尺寸，100、1,000、5,000 个标记，对比独立 SVG、SVG use、共享图像、Canvas 矢量及 Canvas 缓存图像。
- `legacy`：若构建目录存在 `rizhi-growth-preview.html`，附加旧概念预览的重复重建压力测试。

每个构建场景预热后测五次，记录主线程构建/布局提交、元素数量和 JS 堆。JS 堆不等于应用内存，Canvas 像素缓冲和 native DOM 占用也需考虑。

正式的 CPU、物理内存和 GPU 功耗验收应针对 Tauri 发布版单独进行。不要以这些隔离前端样本冒充整机性能结论。
