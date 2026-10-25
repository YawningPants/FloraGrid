# 日枝前端性能样本

## 当前日视图花丛

运行 `node tools/perf/header-garden.mjs`，对真实前端做无花丛、静态花丛和摇曳花丛的对比，采集 CPU 时间、JS 堆、页面结构、单次及连续完成任务。任务数为 50、300、750，另含 18 株的宽窗口和失焦暂停样本。独立临时浏览器和虚构数据，不修改实际日历。

结果在 `src-tauri/target/perf-header-garden.json`。测试禁用历史页面缓存、预热启动，并将静置 CPU 与 RAF 帧探针分开测量。详情见 [日视图花丛性能评估](../../docs/performance/日视图花丛性能评估.md)。

`node tools/perf/header-garden.mjs --optimized` 只复测完整花丛，输出 `perf-header-garden-optimized.json`，保留原先基线文件。

原生后台样本：先运行 `./tools/perf/build-native-profile.ps1`，再运行 `node tools/perf/native-background.mjs`。构建使用全新应用标识、隐藏窗口和独立数据，并保留、恢复已有 release exe；Node 脚本确认原生窗口实际隐藏、动画已暂停后才采样 Windows 进程组的 CPU、私有驻留、提交与工作集，结束后关闭并清理专用配置。结果在 `src-tauri/target/perf-native-background.json`。它不读写实际日历，不生成安装包。

## 历史花型与渲染器样本

运行 `node tools/perf/flowers.mjs`，使用独立 Chrome 用户目录，测试当前真实日视图代码与五种花朵渲染方式。

可选参数：`app`、`completion`、`field`、`legacy`。浏览器路径可以通过 `CHROME_PATH` 环境变量指定。采集结果位于 `src-tauri/target/perf-flowers-report*.json`。

- `app`：50 项任务、300 项含子任务、750 项含子任务；对可完成的叶子任务操作，验证完成数确实变化。
- `completion`：日枝外观开启开花，预热后测五次；分别记录点击到样式/布局提交的同步耗时，以及覆盖开花和归位的 800 ms 观察窗口内累计 Task、Script、Style/Layout 时间。800 ms 是观察窗口，不是操作耗时；累计任务时间也不是单帧阻塞时间。

- `field`：统一花型和尺寸，100、1,000、5,000 个标记，对比独立 SVG、SVG use、共享图像、Canvas 矢量及 Canvas 缓存图像。
- `legacy`：若构建目录存在 `rizhi-growth-preview.html`，附加旧概念预览的重复重建压力测试。

旧 `completion` 的 800ms 窗口对应早期动效，已不足以覆盖当前的盛开、缩小与背景生长；当前花丛应使用上方 1,600ms 的专项脚本，不能直接比较两种观察窗口的累计时间。

每个构建场景预热后测五次，记录主线程构建/布局提交、元素数量和 JS 堆。JS 堆不等于应用内存，Canvas 像素缓冲和 native DOM 占用也需考虑。

正式的 CPU、物理内存和 GPU 功耗验收应针对 Tauri 发布版单独进行。不要以这些隔离前端样本冒充整机性能结论。

两层扩容对比：`node tools/perf/header-garden.mjs --layers`，输出 `perf-header-garden-layered.json`。对照是同一两层实现的旧数量上限，扩容为 10/14/18。详见 [两层花丛性能评估](../../docs/performance/两层花丛性能评估.md)。
