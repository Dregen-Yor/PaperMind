# PaperMind 标志

主方案为「问页 / Folio」：P 的内白沿斜向页缝打开，呼应论文阅读与提问。胡桃棕符号搭配墨棕衬线字标，延续现有界面的米白、棕色体系。

- [交互预览](index.html)：比较三个方向，切换背景、尺寸并下载 SVG。
- [设计总览](index.png) · [主标预览](logo-preview.png)。
- [完整文件包](papermind-logo-kit.zip)。
- [参考研究](research.md)。

## 可直接使用的文件

| 用途 | 文件 |
| --- | --- |
| 横版组合标志 | [papermind-logo.svg](../../assets/brand/papermind-logo.svg) |
| 独立符号 | [papermind-mark.svg](../../assets/brand/papermind-mark.svg) |
| 反白符号 | [papermind-mark-light.svg](../../assets/brand/papermind-mark-light.svg) |
| 独立字标 | [papermind-wordmark.svg](../../assets/brand/papermind-wordmark.svg) |
| 应用图标矢量源 | [papermind-icon.svg](../../assets/papermind-icon.svg) |
| 应用图标，1024 px | [papermind-icon.png](../../assets/papermind-icon.png) |
| Windows 图标 | [papermind-app-icon.ico](../../assets/brand/papermind-app-icon.ico) |
| macOS 图标 | [papermind-app-icon.icns](../../assets/brand/papermind-app-icon.icns) |
| 16 px 起的网站图标 | [papermind-favicon.svg](../../public/papermind-favicon.svg) |

三个方向都提供独立符号、横版、竖版，以及品牌色、墨棕、反白、黑色四种版本，共 36 个方案 SVG。另有四个独立字标版本、生产用别名与 PNG / ICO / ICNS 导出文件。

## 三个方向

| 方向 | 视觉特征 | 应用倾向 |
| --- | --- | --- |
| 问页 / folio，推荐 | 一条斜向开口贯穿 P 的内白与外轮廓 | PaperMind 的主要品牌标志，适合应用图标与界面 |
| 文间 / open-leaf | 两片弧形书页围出开放的书脊 | 更偏重阅读、图书与出版的气质 |
| 双引 / dialogue | 错位、呼应的两个引文形状 | 更偏重讨论与引用的抽象表达 |

所有方案文件位于 `assets/brand/concepts/<方向>/`。命名为 `papermind-<方向>-<icon|horizontal|stacked>-<brand|ink|reverse|black>.svg`。

## 配色与排版

| 颜色 | RGB | 角色 |
| --- | --- | --- |
| 胡桃棕 | `#73543C` | 主符号、深色底板 |
| 象牙白 | `#FFFDF8` | 浅色底板、反白符号 |
| 墨棕 | `#352D26` | 字标、单色版本 |
| 印刷黑 | `#161616` | 黑色单色版本 |

棕色与象牙白的对比度约为 6.75:1。`brand` 版本的符号为胡桃棕，字标为墨棕；`reverse` 版本用于深棕等深色背景。单色版本保留全部几何结构。

字标基于 Adobe **Source Serif 4 Semibold**，已转换为路径，打开 SVG 时不依赖字体安装，也不需要联网。字体采用 SIL Open Font License 1.1，见[字体许可](../../assets/brand/SOURCE-SERIF-LICENSE.md)及[字体项目](https://github.com/adobe-fonts/source-serif)。界面正文继续使用原有系统字体。

## 尺寸与保护空间

- 符号的设计画板为 128 × 128。轮廓外至少保留 16 单位空间；提供的图标 SVG 已包含该空间。
- 独立符号建议不小于 24 px。浏览器标签等 16 px 场景使用专用 favicon，以保留底色和轮廓。
- 横版组合标志建议不小于 160 px 宽，竖版建议不小于 120 px 宽。
- 保持原始宽高比例和斜切角度，使用现成的反白或单色版本；导出时保留透明背景与画板边距。
- 应用图标的 PNG 为 1024 × 1024，含透明外边距。ICO 包含 16、24、32、48、64、128、256 px 尺寸；ICNS 包含 macOS 所需的多尺寸图像。

## 项目中的应用

主方案已接入侧栏、问答头像、空白对话、设置页和 favicon。Electron 使用更新后的应用图标；Linux、macOS、Windows 的打包配置指向相应文件。

当前打包图标由 `assets/papermind-icon.svg` 生成到 `assets/icons/`：Linux 使用
`assets/icons/linux/`，macOS 使用 `assets/icons/mac.icns`，Windows 使用
`assets/icons/win.ico`。修改矢量源后运行 `npm run icons:generate`，再运行
`npm run icons:check`；上表中的 `assets/brand/` 文件同时保留为标志文件包的导出素材。

矢量构形与配色参数记录在 [design-source.json](../../assets/brand/design-source.json)。在 Figma、Illustrator 或 Inkscape 中导入 SVG 即可继续编辑。

## 标志制作时的验证记录

- `npm test`：25 个测试文件、302 项测试通过。
- `npm run typecheck`：通过。
- `./node_modules/.bin/vite build`：应用、Electron 主进程与 preload 构建通过。
- 47 个 SVG 均通过 XML 与 viewBox 检查，没有外部字体、图片或脚本依赖。
- PNG 的尺寸与透明外边距、ICO 的七种尺寸及 ICNS 解码均已检查；三个平台的打包图标路径均有效。
- 设计页的 25 项 DOM 检查通过，覆盖本地图片路径、九种方案与背景组合、四档尺寸及对应下载链接。

设计总览与主标预览由矢量源直接渲染，已检查中文显示、配色和小尺寸轮廓。本轮未执行真实浏览器的布局回归与安装器打包。

## 2026-10-03 远程同步后的验证

- `npm test`：98 个 Vitest 文件、1311 项测试通过；品牌/安装测试 18 项通过，
  1 项因本机未安装 `desktop-file-validate` 跳过。
- `npm run typecheck`、`npm run icons:check`、`git diff --cached --check`：通过。
- `CSC_IDENTITY_AUTO_DISCOVERY=false npm run build -- --dir` 的编译阶段通过；
  下载 Electron 需要网络权限，随后运行 `electron-builder --dir` 成功生成
  macOS ARM64 应用包。本次应用包未签名，未生成安装器。
- 使用临时数据目录启动真实 Electron 构建，离线导航到文献库、论文问答和设置页；
  页面标题与品牌图片加载正确，未观察到渲染脚本错误。此检查未验证在线模型推理。
