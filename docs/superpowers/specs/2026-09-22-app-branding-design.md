# PaperMind 应用名称与跨平台图标修正方案

日期：2026-09-22。状态：待用户评审的方案草案，尚未实施。

## 目标与边界

用户反馈 macOS 启动后仍出现默认身份、悬浮名称为 Electron，且 Dock 图标比相邻应用偏大。目标是让 PaperMind 的应用名称、图标和视觉尺寸一致，并兼顾 Windows、Linux。

这是现有启动和打包流程的局部修正。按用户“探讨修改方案并落盘”的要求保存本文；当前不修改产品代码。默认保留现有书本与知识图谱品牌图案，不重新设计 logo。截图对应开发启动还是正式安装包尚待用户补充；方案覆盖两种入口，不能把其中一种的结果当成另一种的验收。

## 已核实的现状

- `assets/papermind-icon.svg` 的圆角背景占满 512 × 512 画布；PNG 也是 512 × 512，具有透明通道，但主体没有外围安全留白。截图中的书本图案与该资源一致，因此截图本身不是 Electron 默认原子图标的证据。视觉偏大与素材铺满画布相符，仍需排除 Dock 放大效果后比较。
- `electron/main.ts` 已调用 `app.setName('PaperMind')`；macOS 开发启动后还会调用 `app.dock.setIcon()`，路径依赖 `process.cwd()`，读取失败时静默跳过。`BrowserWindow` 未配置图标。
- `scripts/dev.mjs` 复制 Electron 到 `node_modules/.papermind-electron/Electron.app`，仅更新 `CFBundleName` 与 `CFBundleDisplayName`。
- 当前本地副本的 plist 名称已是 PaperMind，但 `CFBundleIdentifier` 仍是 `com.github.Electron`，图标仍指向 `electron.icns`。目录也仍叫 Electron.app。已有的局部改名不能证明系统身份完整更新；具体哪个因素造成当前悬浮名称，需实际重启验证。
- `scripts/ensure-electron.mjs` 仅按 Electron 版本失效缓存；品牌资源更新不会触发重建。
- 本地 `node_modules/electron/index.js` 将 `ELECTRON_OVERRIDE_DIST_PATH` 与 `path.txt` 拼接；后者是 `Electron.app/Contents/MacOS/Electron`。直接改应用包目录名会破坏启动。
- `package.json` 已有 `productName: PaperMind` 和 `build.appId: com.papermind.app`；只为 macOS 指定 PNG 图标。构建文件列表未包含 `assets`，不能假设开发资源在安装包运行时仍能找到。
- `scripts/install.sh` 为 Linux 手写的 desktop 文件没有 `Icon` 字段；即便 AppImage 内置图标正确，这个入口也可能没有品牌图标。

## 方案比较

| 方案 | 内容 | 取舍 |
| --- | --- | --- |
| A：仅补运行时设置 | 调整 Dock PNG、名称调用和窗口图标 | 修改少，但不能覆盖 Finder、安装包与系统启动器身份，不推荐 |
| B：统一资源、开发包身份、发布配置（推荐） | 保留现有品牌，按平台输出资源，补全开发启动和发布链路 | 能覆盖反馈，也沿用当前工具链 |
| C：开发也先打完整应用包 | 每次在品牌化的打包应用中开发 | 身份更接近发布态，但增加构建成本并影响现有开发体验，本次不采用 |

## 推荐设计

### 1. 同一品牌母版，按平台输出

保留 `assets/papermind-icon.svg` 作为品牌母版，新增可重复生成的操作系统图标资源，建议目录 `assets/icons/`。不要把 macOS 的额外留白应用到网页内 logo。

- macOS：从矢量图生成 1024 × 1024 透明画布，图案主体先以约 82% 的画布宽高居中作为设计起点，再通过 Dock 对照确定最终比例。这是视觉建议，不是 Apple 强制尺寸。输出多尺寸 ICNS 和相同构图的开发态 PNG，避免运行前后视觉跳变。
- Windows：生成包含 16、24、32、48、64、128、256 像素表示的 ICO；小尺寸检查书本和节点是否仍清楚。使用独立的留白参数，不照搬 macOS 的缩放比例。
- Linux：输出 16、32、48、64、128、256、512 像素 PNG 图标目录；遵循桌面主题的显示方式，不承诺所有桌面环境像素级一致。
- 提供明确的生成入口并固定生成工具版本。普通开发直接使用已提交的图标产物，不应每次启动都依赖 macOS `iconutil` 或在线下载。ICNS 如采用 macOS 工具生成，明确只用于维护资源，不进入 Windows/Linux 日常启动路径。

### 2. macOS 开发包完整品牌化

沿用项目专属副本，目标为 `.papermind-electron/PaperMind.app`，保留 Electron 原始分发目录。更新副本的名称字段、图标文件引用，并使用 `com.papermind.app.dev` 区分开发态身份；正式包保持 `com.papermind.app`。内部主二进制可继续名为 Electron，`CFBundleExecutable` 必须与实际文件一致。

不能只重命名目录：通过 vite-plugin-electron 当前支持的 `startup` 第三个参数 `customElectronPkg` 接入本地生成的模块，该模块默认导出副本可执行文件的绝对路径。`vite.config.ts` 仅在 macOS 开发入口传入它，其余平台保留现有启动方式；维持插件已有的进程退出和热重启管理。实现前用当前安装版本核验模块加载方式和带空格路径。

将缓存指纹扩展为 Electron 版本、架构、品牌脚本版本及图标内容哈希；仅在指纹变化或文件不完整时重建，完成复制和品牌化后才写成功标记。与 `ensure-electron.mjs` 统一缓存职责，避免一个脚本认为已就绪、另一个只留下半成品。

修改应用包可能影响原始签名；在本机验证签名与实际启动。若需本地 ad-hoc 重签，仅处理开发副本，先完成资源修改再签名。正式包由 electron-builder 的发布签名流程负责。

### 3. 运行时资源与发布配置

`electron/main.ts` 保留现有 `app.setName('PaperMind')`。用明确的开发资源根路径及打包资源路径定位图标，避免依赖启动时工作目录；打包使用 `extraResources` 包含所需的运行时 PNG/ICO，资源路径从 `process.resourcesPath` 解析。

- macOS：开发包内置 ICNS 为基础；如保留 ready 后的 `dock.setIcon`，必须使用相同留白的 PNG。正式包依赖包内 ICNS，不用另一份运行时素材覆盖。资源缺失应有可定位的开发日志；构建阶段缺失必需资源直接失败。
- Windows：显式设置 `win.icon`，窗口使用正确资源，调用 `app.setAppUserModelId('com.papermind.app')` 并核验安装器快捷方式身份一致。开发进程的 exe 属性仍可能显示 Electron，不能用窗口图标设置承诺修改通用 Electron 可执行文件的元数据；正式安装包应完整品牌化。
- Linux：显式设置 `linux.icon`，窗口使用 PNG；核对实际打包生成的 desktop 文件名、窗口身份和安装脚本入口。为安装脚本补充本地持久保存的图标及 `Icon` 字段，优先从发布产物提取，避免引用源码目录或临时挂载路径。如需调整 desktop 文件名，同步 `app.setDesktopName` 和旧入口清理，避免重复启动项。

平台专属 API 和 macOS 工具仅在对应平台分支调用。保持现有用户数据目录行为：开发态 bundle ID 变化不应附带更改 `app.getPath('userData')`；验收时对比实际路径与已有数据库是否仍可读取。

### 4. 涉及文件

主要涉及 `assets/icons/`、图标生成脚本、`scripts/dev.mjs`、`scripts/ensure-electron.mjs`、`vite.config.ts`、`electron/main.ts`、`package.json`、`scripts/install.sh` 及 README 的开发/资源说明。按实际选用的生成工具更新锁文件。无需改 Vue 页面、数据库结构或 IPC 接口。

## 验证与验收

自动验证重点是实际容易退化的分支：非 macOS 不调用 plist/签名工具；品牌资源或 Electron 版本变更能正确重建缓存；带空格及不同工作目录启动能定位资源；打包所需图标全部存在并具有正确格式。配置与脚本测试应验证结果，不堆砌字符串快照。

实施后运行仓库要求的 `npm run typecheck` 与 `npm test`，并在各平台构建/安装验证。单靠这两条命令无法验收系统 Dock 和图标缓存。

| 环境 | 验收内容 |
| --- | --- |
| macOS 开发 | 首次与重复 `npm run dev`、修改图标后重启、Electron 升级后启动；Dock 悬浮名称 PaperMind，图标为同一品牌，热重启无额外残留进程 |
| macOS 安装包 | 新打包 DMG 安装后启动；Finder、Dock、Cmd-Tab 名称与图标正确；退出后固定图标仍正确；核验签名与启动 |
| macOS 尺寸对照 | 鼠标离开 Dock 或关闭放大效果，在相同 Dock 设置下与相邻圆角图标比较；主体大小协调、居中、边缘清晰，保留前后截图 |
| Windows | 本机开发启动无 macOS 工具调用；正式 NSIS 安装器、exe、快捷方式、任务栏品牌正确，窗口分组合理 |
| Linux | 开发与 AppImage 启动；安装脚本创建的应用菜单入口有图标；至少在一个 GNOME/KDE 环境验证窗口匹配，并记录 X11/Wayland 条件 |
| 数据兼容 | 品牌化前后实际 userData 路径一致，旧论文、设置和 API 配置仍能加载 |

若仍显示旧名称，先核验实际启动包路径和包内容，再测试新 Dock 项；仅针对旧固定项进行移除和重新固定。不要把重启系统 Dock、全局清图标缓存或关闭系统安全机制作为默认修复步骤。未运行的平台明确标为待验收。

## 依据与限制

- [Electron app.setName](https://www.electronjs.org/docs/latest/api/app#appsetnamename)：只覆盖 Electron 内部名称，不改变操作系统使用的名称。
- [Electron Dock API](https://www.electronjs.org/docs/latest/api/dock)：运行时 Dock 图标接口属于 macOS。
- [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)：窗口图标与应用分发包身份需要分别处理。
- electron-builder 平台格式同时核对了本地安装版本的 `macOptions.d.ts`、`winOptions.d.ts`、`linuxOptions.d.ts`。不直接依赖在线新版文档的 SVG 自动转换功能。
- 启动路径方案依据本地 Electron `index.js`、`path.txt` 与 vite-plugin-electron 的 `startup` 接口。当前没有运行新启动器或重新打包，根因中的系统缓存、悬浮命名优先级和最终视觉比例仍需实施时实测。
