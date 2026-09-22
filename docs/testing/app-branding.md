# 应用名称与图标验收记录

对应计划：`docs/superpowers/plans/2026-09-22-app-branding.md` 的 Task 5（全量验证、平台验收及维护文档）。注意该计划是作者本地、**未提交**的工作文档（不在仓库的提交历史里，其他机器上不存在该路径）。

- 代码版本：分支 `fix/electron`，验收基线提交 `be06223`（验收过程未改动产品代码；改动只有 README 的维护说明与本文档，修复轮仅订正本文档的证据引用、未改任何验收结论）
- 验收机器：macOS 26.4.1（Build 25E253，Darwin 25.4.0）、Apple Silicon（arm64）、Aqua/Dock 桌面
- 工具链：Electron 44.2.0、Vite 6.4.3、electron-builder 24.13.3、Node v25.9.0、npm 11.12.1（`package.json` 的 `engines` 声明 `npm <11`，npm 默认不强制，本次未受影响）
- 本地证据目录（**未提交**，`.superpowers/` 已在 `.gitignore` 中）：`.superpowers/sdd/2026-09-22-app-branding/evidence/`；下文以 `evidence/...` 引用。Step 1 四项检查的完整输出见 `evidence/fix-round-*.log`（修复轮在同一基线重跑），其余引用都指向该目录内的具体文件；没有归档的观察会在正文里就地注明
- 命名约定：`<repo>` 指仓库根目录，`<copy>` 指挂载 DMG 后复制出的临时验证副本目录（本次为 `/tmp/papermind-verify-KlNn`，`/tmp` 可能被系统清理；重建命令见第三节）
- 结论：macOS 开发态与 DMG 安装包验收通过（签名状态与视觉比例例外，见下）；Windows 与 Linux **未运行：缺少对应平台环境**；Dock 截图与视觉比例结论待用户人工确认

## 一、自动检查（Step 1）

| 命令 | 平台 | 结果 | 关键输出 |
| --- | --- | --- | --- |
| `npm run icons:check` | macOS arm64 | 通过 | `[icons] 校验通过：mac.png / mac.icns / win.ico / linux/*.png` |
| `npm run typecheck` | macOS arm64 | 通过 | `vue-tsc --noEmit`，无输出 |
| `npm test` | macOS arm64 | 通过 | Vitest 74 文件 / 944 用例全通过；`test:branding` 19 项 → 18 通过、1 跳过、0 失败 |
| `git diff --check` | macOS arm64 | 通过 | 无输出 |

唯一跳过的用例是 `scripts/tests/linux-install.test.mjs` 里依赖 `desktop-file-validate` 的那一项，原因是本机没有该命令；测试自身打印了跳过原因，不是被隐藏的失败。

Vitest 会收集 `exclude` 之外的任意 `*.test.*` 文件：`vite.config.ts` 的 `test.exclude` 只覆盖 `node_modules`、`dist`/`dist-electron`/`release`、`electron/**`、根 `scripts/tests/**` 与 `**/.worktrees/**`，把测试文件复制到别的位置（例如此前放在 scratch 目录里的副本）会让 `npm test` 误报失败——本次就删掉过两份这样的副本才恢复全绿。当前仓库在 `src/`、`bench/`、`scripts/tests/` 之外没有会被收集的测试文件（`npx vitest list --filesOnly` 收 74 个文件，见 `evidence/test-file-collection.txt`；`.worktrees/` 下的 worktree 副本命中 exclude，不计入）。

### 图标生成不依赖网络、macOS 工具或应用启动

`scripts/generate-icons.mjs` / `scripts/lib/icon-assets.mjs` 的全部 import 只有 `node:url`、`node:fs/promises`、`node:path`、`sharp` 和同仓库的相对模块 `./lib/icon-assets.mjs`：不 spawn 子进程、无网络调用、不 import Electron。另做了隔离复现（把 `scripts/`、`assets/papermind-icon.svg` 复制到临时根目录，`node_modules` 用符号链接）：

```bash
# 在临时根目录执行：沙箱拒绝网络，Node 权限模型未授予 --allow-child-process
sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  node --permission --allow-addons \
       --allow-fs-read="$TMP" --allow-fs-write="$TMP" \
       --allow-fs-read=<repo>/node_modules \
       "$TMP/scripts/generate-icons.mjs"
```

结果：exit 0，且生成的 10 个产物与已提交产物逐字节一致（`mac.icns`、`mac.png`、`win.ico`、`linux/*.png` 全部 sha256 MATCH，见 `evidence/icon-gen-isolated.txt`）。即：生成图标不需要网络、不需要 `plutil`/`codesign`/`sips` 等系统命令、不需要启动应用，已提交产物可以从母版确定性复现。

### 构建脚本的图标门禁

`package.json` 的 `build` 是 `npm run icons:check && vue-tsc --noEmit && vite build && electron-builder`，门禁排在最前。本次真实构建日志（`evidence/build-dmg.log`）第 3 行即该命令，第 9 行是校验通过输出，之后才进入 electron-builder。失败路径在隔离副本中演示（把 `mac.png` 换成 512px 图，**未改动仓库内的产物**）：

```bash
node "$GATE/scripts/check-icons.mjs"
# → [icons] 校验失败：assets/icons/mac.png: expected 1024x1024 PNG, got 512x512
# → exit 1
```

通过/失败两条路径的原始输出（含失败信息原文与两次 `exit` 值）见 `evidence/icons-check-gate.txt`；该文件是修复轮在隔离副本中重录的，仓库产物未被改动。

## 二、macOS 开发态验收（Step 2）

每次都是限时后台运行（`npm run dev` 在独立进程组），观察完对进程组发 SIGINT（等价终端 Ctrl-C），随后检查残留进程。

harness 日志里的 `npm run dev exited code=1 signal=null` 是收到 SIGINT 后的正常表现：npm 把被中断的脚本报成非零退出码，不代表启动失败。退出是否干净以每个场景末尾的残留检查为准（见下表 Ctrl-C 行）。

| 场景 | 操作 | 观察结果 | 证据 |
| --- | --- | --- | --- |
| 首次启动（先删除 `node_modules/.papermind-electron`） | `npm run dev` | 重新构建品牌副本：日志 9 行 `replacing existing signature`（8 个嵌套项 + 外层 bundle）；缓存指纹文件生成 | `evidence/run1-dev.log`、`evidence/run1-harness.txt` |
| 缓存复用 | 再跑一次 `npm run dev` | 缓存内 `.branding.json`、`launcher.mjs`、`Info.plist`、`papermind.icns` 的 mtime 均保持 `19:23:00` 不变，日志无签名行 → 未重建、未重签 | `evidence/run2-harness.txt`（mtime）、`evidence/run2-dev.log`（0 行签名输出） |
| 图标内容变化 | 临时给 `assets/icons/mac.icns` 追加字节后 `npm run dev` | 指纹 `a450a774…` → `5277becc…`，副本与缓存 mtime 更新，`codesign --verify --deep --strict` 仍 exit 0 | `evidence/run5-harness.txt`、`evidence/run7-harness.txt`（`a450a774…`）、`evidence/run4-harness.txt`（`5277becc…` 与 verify） |
| 恢复正确产物 | 还原 `mac.icns` 后再 `npm run dev` | 缓存指纹回到 `a450a774…`，副本用正确图标重建；文件 sha256 回到 `63ee71b7…`，`git status --porcelain assets/icons` 为空 | `evidence/run5-harness.txt`（缓存指纹）、`evidence/icon-restore-recheck.txt`（修复轮只读复核 sha256、git 状态与 `HEAD:assets/icons/mac.icns` 一致性） |
| 缓存缺文件 | 删除副本内 `Contents/Resources/papermind.icns` 后 `npm run dev` | 重新构建并重签（日志 9 行签名输出）；还原出的副本图标与 `assets/icons/mac.icns` 同 sha256 | `evidence/run6-harness.txt`、`evidence/run6-dev.log` |
| 主进程热重启 | 运行中 `touch electron/main.ts` | Electron 主进程 PID `42504` → `42658`（内容未改，仅 mtime 触发 watcher）；缓存 mtime 不变 | `evidence/run2-harness.txt` |
| Ctrl-C 退出 | 对进程组发 SIGINT | `npm run dev` 收到 SIGINT 后退出（harness 记 `code=1 signal=null`，属正常，见上文说明）；`pgrep -f <repo>/node_modules/.papermind-electron` 与 `vite`/`dev.mjs` 残留均为空（每个场景都检查） | `evidence/run2-harness.txt` … `evidence/run7-harness.txt` 末两行均为 `[]`；`evidence/run1-harness.txt` 末两行是 `[probe failed] … pgrep …`（`pgrep` 未匹配到进程时退出码为 1，即当时同样没有残留） |
| 其他目录启动 | `cd /tmp && node <repo>/scripts/ensure-electron.mjs && node <repo>/scripts/dev.mjs` | 正常启动；缓存指纹复用（日志 0 行签名输出）；Electron 进程 cwd 为仓库根，用户数据目录不变 | `evidence/run7-harness.txt`、`evidence/run7-dev.log`（0 行签名输出） |
| Electron 版本变化 | 未做真实升降级（本次约束明确不升级/降级 Electron） | 指纹输入为 Electron 版本 + 架构 + 图标字节 + `REVISION`，该分支由 `scripts/tests/dev-branding.test.mjs` 的 `all identity inputs invalidate fingerprints` 覆盖；本次实机只验证了图标这一支 | `scripts/tests/dev-branding.test.mjs`（`npm run test:branding` 通过） |

### 品牌身份核验

```bash
plutil -p node_modules/.papermind-electron/PaperMind.app/Contents/Info.plist
codesign --verify --deep --strict node_modules/.papermind-electron/PaperMind.app
```

- `CFBundleName` / `CFBundleDisplayName` = `PaperMind`，`CFBundleIdentifier` = `com.papermind.app.dev`，`CFBundleIconFile` = `papermind.icns`
- `codesign --verify --deep --strict` → **exit 0**（ad-hoc 签名副本）
- LaunchServices 记录（Dock / Cmd-Tab 名称的可核查来源）：`lsappinfo list` 显示 `"PaperMind"`、`bundleID="com.papermind.app.dev"`、bundle path 指向 `node_modules/.papermind-electron/PaperMind.app`、`type="Foreground"`
- 进程名：`ps` 中主进程为 `…/.papermind-electron/PaperMind.app/Contents/MacOS/Electron`
- 图标加载：dev 运行日志中没有出现 `electron/main.ts` 的 `[branding] Unable to load icon` 警告，说明 `app.dock.setIcon` 使用的 `assets/icons/mac.png` 读取成功

以上各条取自 `evidence/run1-harness.txt`（`plutil` 全文、`codesign_exit=0`、`ps`）与 `evidence/run2-harness.txt`（`lsappinfo` 指向 dev 副本）；图标警告的缺席在 `evidence/run*-dev.log` 里逐文件计数确认（全部 0，见 `evidence/fix-round-environment-recheck.txt`）。

### 用户数据路径与原数据可读性

用户数据路径从**运行中的主进程**读取，不记录库内数据。方法：对 dev 主进程发 `SIGUSR1` 打开仅监听 127.0.0.1 的 Node inspector，再用 CDP `Runtime.evaluate` 取值；随进程退出即消失，未改动任何产品代码。

```js
// 在运行中的 dev 主进程里求值
JSON.stringify({
  name: app.getName(),
  userData: app.getPath('userData'),
  appPath: app.getAppPath(),
  packaged: app.isPackaged,
})
// → {"name":"PaperMind",
//    "userData":"/Users/xmdjy/Library/Application Support/PaperMind",
//    "appPath":"<repo>","packaged":false}
```

- `app.getPath('userData')` = `~/Library/Application Support/PaperMind`（`evidence/run3-harness.txt`、`evidence/run7-harness.txt`）
- 该目录在磁盘上的目录项名是小写 `papermind`（APFS 大小写不敏感，两种拼写是同一 inode 12683777），`lsof` 因此显示小写路径；dev 与打包版指向同一份数据（只读复核见 `evidence/fix-round-environment-recheck.txt`）
- 原论文与设置可读：运行中的 dev 主进程持有 `papermind.db`、`papermind.db-shm`、`papermind.db-wal` 文件句柄（只记录路径，不读取内容，`evidence/dev-app-lsof.txt`），窗口正常创建，运行日志无 SQLite 或初始化错误；`papers/` 目录存在且非空（修复轮只读复核：目录存在、含 3 个条目，只记录数量、不记录文件名，见 `evidence/papers-dir-check.txt`）
- 明确未做：直接打开数据库文件比对内容（会暴露论文与 API Key），因此本记录不含任何数据行；“设置与 API 配置仍能加载”只有上述间接证据（同一路径、同一组文件被应用打开且无初始化错误），要彻底确认请在应用界面里查看设置页与对话页
- 品牌化前后 userData 路径未变：dev 与打包版读到的都是 `~/Library/Application Support/PaperMind`，与旧版本使用的目录一致

## 三、macOS 安装包验收（Step 3）

### 构建

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false \
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
npm run build
```

- 全流程通过：`icons:check` → `vue-tsc` → `vite build` → `electron-builder`
- Electron 44.2.0 的 `electron-v44.2.0-darwin-arm64.zip`（130 MB）通过镜像下载成功，耗时 8.573 s
- 产物：`release/PaperMind-0.1.0-arm64.dmg`，177,057,296 字节，2026-09-22 19:31（复核：`evidence/build-dmg.log` 末尾补录的 `ls -l`/`stat`）
- 注意：构建前 `release/` 里 7 月 21 日的旧 DMG 与本产物文件名仅大小写不同，在大小写不敏感卷上是同一路径，已被本次构建覆盖（`release/` 是 gitignore 的构建输出，不在提交范围内）
- 完整日志：`evidence/build-dmg.log`

### 签名状态（如实记录）

```bash
codesign --verify --deep --strict <copy>/PaperMind.app
# → <copy>/PaperMind.app: code has no resources but signature indicates they must be present
# → exit 1
```

本机 `security find-identity -v -p codesigning` 无任何签名身份（`0 valid identities found`），构建按 `CSC_IDENTITY_AUTO_DISCOVERY=false` 跳过签名：外层 bundle 仍带官方 Electron 二进制的 linker-signed 标记（`Identifier=Electron`、`flags=0x20002(adhoc,linker-signed)`、`Sealed Resources=none`），资源封印已经失效，`spctl -a -vv` 报同一句话。该状态不阻止本地启动（本地产物没有 quarantine 属性），实测正常启动运行；作为发行包则需要开发者证书签名与公证——这是发行前置条件，不是本次代码缺陷，也不在本机可行范围内。**未**对副本做 ad-hoc 重签（因为不需要）；开发态副本的 ad-hoc 签名核验见第二节。以上工具输出（修复轮只读重录）见 `evidence/packaged-app-signing.txt`。

### 安装与启动核验（挂载 DMG → 复制到临时目录，未触碰 `/Applications`）

DMG 卷内容（只读复核见 `evidence/packaged-app-resources.txt`）：有意义的内容是 `PaperMind.app`、`Applications -> /Applications` 符号链接、`.VolumeIcon.icns`、`.background`（另有 `.DS_Store` 与挂载时产生的 `.fseventsd` 等 macOS 元数据）。`/Applications` 当前**没有** PaperMind 安装（`ls: /Applications/PaperMind.app: No such file or directory`，修复轮复核见 `evidence/fix-round-environment-recheck.txt`），本次没有向 `/Applications` 写入任何文件，标准拖拽安装留给用户。

启动方式：挂载后 `cp -R` 到临时目录，分别用 `open -n <copy>`（等价 Finder/LaunchServices 启动）和直接执行 `<copy>/Contents/MacOS/PaperMind` 各测一次，窗口都正常加载；下表的运行时取值是修复轮在直接执行的实例上重录的。

| 检查项 | 结果 |
| --- | --- |
| Info.plist 身份 | `CFBundleName` / `CFBundleDisplayName` = `PaperMind`，`CFBundleIdentifier` = `com.papermind.app`，`CFBundleExecutable` = `PaperMind`，`CFBundleIconFile` = `icon.icns`，`CFBundleShortVersionString` = `0.1.0` |
| 包图标 | `Contents/Resources/icon.icns` 与 `assets/icons/mac.icns` sha256 相同（`63ee71b7…`） |
| 运行时资源 | `Contents/Resources/icons/` 含 `mac.icns`、`mac.png`、`win.ico`、`linux/{16,32,48,64,128,256,512}.png`（extraResources 生效） |
| Finder 可见包名 | `PaperMind.app`（DMG 卷与临时副本内的文件名） |
| Dock / Cmd-Tab 名称 | `lsappinfo`：条目名 `"PaperMind"`、`bundleID="com.papermind.app"`、`type="Foreground"`、`Version="0.1.0"`、`Arch=ARM64` |
| 进程名 | 主进程 `…/PaperMind.app/Contents/MacOS/PaperMind`；`PaperMind Helper`（GPU / Renderer）、NetworkService |
| 窗口 | `BrowserWindow.getAllWindows()` → `url=file://…/app.asar/dist/index.html#/library`、`title="PaperMind"`、`visible=true`、`crashed=false` |
| 打包态身份 | `app.isPackaged=true`，`userData=~/Library/Application Support/PaperMind` |
| 数据兼容 | 打包版主进程打开 `papermind.db`、`papermind.db-shm`、`papermind.db-wal`（与 dev 同一目录、同一组文件） |
| 退出 | SIGTERM 主进程后无任何 PaperMind 进程残留 |

证据：上表“Dock / Cmd-Tab 名称”“进程名”“窗口”“打包态身份”“退出”等运行时取值见 `evidence/packaged-app-runtime.txt`（修复轮重录：`ps` 进程表、`lsappinfo` 的条目名/`Version`/`Arch`、CDP 读到的 `isPackaged` 与窗口 `url`/`title`/`visible`/`crashed`、SIGTERM 后残留为空）；“Info.plist 身份”“包图标”“运行时资源”“Finder 可见包名”见 `evidence/packaged-app-resources.txt`（`plutil` 全文、`icon.icns` 与源产物同 sha256、`Contents/Resources/icons/` 列表、DMG 卷列表）；数据句柄见 `evidence/packaged-app-lsof.txt`；`evidence/packaged-app-stdout.log` 只含调试器横幅 5 行（306 字节），本身不含上表取值；缺签名身份的现状见 `evidence/packaged-app-signing.txt`。

### 视觉比例（待用户目视确认，不写 PASS）

客观测量（`sharp` 解码 alpha 通道取不透明像素包围盒）：

| 对象 | 主体占画布 | 说明 |
| --- | --- | --- |
| `assets/icons/mac.png`（本次产物） | **82.03%**（840/1024，x=92..931） | alpha≥8 与 alpha≥128 两个阈值结果一致 |
| Apple 系统图标（Finder / Dock / TextEdit / Safari 实测） | **80.47%**（824/1024，x=100..920，alpha≥128） | 四个图标逐项测量见 `evidence/icon-coverage-128.txt`（修复轮补录 Dock 与 Safari）；alpha≥8 时因投影与抗锯齿为 83.59%，四个值见 `evidence/icon-coverage.txt` |
| 旧 `assets/papermind-icon.png`（此前随包分发） | **100.00%** | 满画布，无留白 |

测量可复现：脚本副本 `evidence/measure-icon.mjs`（只依赖仓库内的 `sharp`；`ICON_ALPHA_THRESHOLD` 缺省为 8），在仓库根目录执行：

```bash
ICON_ALPHA_THRESHOLD=128 node .superpowers/sdd/2026-09-22-app-branding/evidence/measure-icon.mjs \
  assets/icons/mac.png assets/papermind-icon.png \
  "/System/Library/CoreServices/Finder.app/Contents/Resources/Finder.icns" \
  "/System/Library/CoreServices/Dock.app/Contents/Resources/AppIcon.icns" \
  "/System/Applications/TextEdit.app/Contents/Resources/AppIcon.icns" \
  "/Applications/Safari.app/Contents/Resources/AppIcon.icns"
```

去掉 `ICON_ALPHA_THRESHOLD=128` 即得 alpha≥8 的那组数；`.icns` 输入自动取其中最大的 PNG 表示。

即本次图标比 Apple 1024 网格主体（824/1024）大约 1.6 个百分点、比旧资源小 18 个百分点，落在接近系统网格的区间。最终“Dock 里看起来大小是否合适”必须由用户在真实 Dock 上判断。

对照条件（本机现状，可复现：`evidence/fix-round-environment-recheck.txt`）：`defaults read com.apple.dock tilesize` = `64`，`magnification` = `0`（无放大效果，不需要额外关闭），`defaults read com.apple.dock orientation` 缺键报错即未设置、默认底部；即测量时不受 Dock 悬停放大干扰。

**缺一张图**：本机 `screencapture` 没有屏幕录制权限，取图直接失败：

```bash
/usr/sbin/screencapture -x /tmp/shot.png
# → could not create image from display   （exit 1）
```

因此没有生成 Dock 截图，也没有用任何方式绕过系统权限。本次的临时验证副本在 `/tmp/papermind-verify-KlNn/PaperMind.app`（`/tmp` 可能被系统清理），重建方式：`mkdir -p /tmp/pm-dmg-verify /tmp/papermind-verify-KlNn && hdiutil attach <repo>/release/PaperMind-0.1.0-arm64.dmg -nobrowse -readonly -mountpoint /tmp/pm-dmg-verify && cp -R /tmp/pm-dmg-verify/PaperMind.app /tmp/papermind-verify-KlNn/ && hdiutil detach /tmp/pm-dmg-verify`（少 `mkdir -p` 时 `cp` 会因目标目录不存在而失败，已实测，见 `evidence/dmg-rebuild-seq.txt` 首节的失败演示）。请用户自行目视：`npm run dev` 后看 Dock 中的开发实例，或从 DMG 启动临时副本，与相邻系统图标比较大小与留白；如需留存截图，先给终端授予“屏幕录制”权限，再执行
`screencapture -x -R0,<屏高-150>,<屏宽>,150 ~/dock.png`。同理，“退出后 Dock 固定项仍显示正确图标”需要人工：请从**最终安装位置**（而不是临时验证副本）固定后再退出观察。

## 四、验收表

| 平台/架构/桌面环境 | 开发名称/图标 | 安装包名称/图标 | 退出/重启 | 数据路径 | 截图/命令证据 | 结果 |
| --- | --- | --- | --- | --- | --- | --- |
| macOS 26.4.1 (25E253) / arm64 / Aqua Dock（非 X11/Wayland） | `PaperMind`（`app.getName()`）；Dock 图标取自 `assets/icons/mac.png`，LaunchServices 记录一致 | —（本行只覆盖开发态） | SIGINT 退出无残留；`touch electron/main.ts` 触发主进程热重启（PID 42504→42658） | `~/Library/Application Support/PaperMind`（磁盘目录项 `papermind`，同一 inode） | `evidence/run1-harness.txt` … `evidence/run7-harness.txt`、`evidence/dev-app-lsof.txt` | 通过（图标外观见下一行） |
| macOS 26.4.1 (25E253) / arm64 / Aqua Dock | —（本行只覆盖打包态） | `PaperMind.app`（`release/PaperMind-0.1.0-arm64.dmg`）；`CFBundleIdentifier=com.papermind.app`；`icon.icns` 与母版产物同 hash | SIGTERM 退出后无残留 | 同上一行（开发版与打包版共用） | `evidence/build-dmg.log`、`evidence/packaged-app-runtime.txt`（运行时取值）、`evidence/packaged-app-lsof.txt` | 部分通过：名称/图标/启动/退出/数据路径通过；`codesign --verify --deep --strict` 失败（本机无签名身份，见第三节） |
| macOS Dock 视觉比例（同一台机器） | 主体占画布 82.03%；Apple 系统图标实测 80.47%；旧资源 100% | — | — | — | `evidence/icon-coverage.txt`、`evidence/icon-coverage-128.txt`（修复轮补录四个系统图标）、脚本副本 `evidence/measure-icon.mjs`；Dock 截图缺失（无屏幕录制权限） | 待用户目视确认（非 PASS） |
| Windows x64 / Windows 桌面 | 未运行：缺少对应平台环境 | 未运行：缺少对应平台环境 | 未运行：缺少对应平台环境 | 未运行：缺少对应平台环境 | — | 未运行：缺少对应平台环境 |
| Linux x64 / GNOME 或 KDE、X11 或 Wayland | 未运行：缺少对应平台环境 | 未运行：缺少对应平台环境 | 未运行：缺少对应平台环境 | 未运行：缺少对应平台环境 | — | 未运行：缺少对应平台环境 |

Windows 行说明：本机是 macOS，`npm run build` 只产出 DMG，没有生成 NSIS 安装器，也没有交叉构建，因此安装器、exe、开始菜单、快捷方式、任务栏图标均无实机结果；开发通用 `electron.exe` 元数据限制这次也无法实测。

Linux 行说明：本机 `release/` 里没有 AppImage，且 `7z`、`unsquashfs`、`desktop-file-validate` 均不存在，无法执行 `--appimage-extract`、`desktop-file-validate`、`gio launch`。据 electron-builder 24 的通用布局**推断**（本机无 Linux 环境，未核实）：AppImage 内部的图标路径为 `usr/share/icons/hicolor/512x512/apps/com.papermind.app.png`，desktop 文件名为 `com.papermind.app.desktop`（`Icon`、`StartupWMClass` 均匹配 `com.papermind.app`）。这两项是**待验证假设**，必须由 Linux 主机提取实物后核实，核实前不要把推断当成已验证事实、也不要据此发布；`scripts/tests/linux-install.test.mjs`（本机 18 通过、1 因缺 `desktop-file-validate` 跳过）只覆盖安装函数逻辑，不能替代实机验收。

## 五、执行过的命令清单

`<repo>` 为仓库根目录，`<copy>` 为临时验证目录。

自动检查与图标：

```bash
npm run icons:check
npm run typecheck
npm test
git diff --check
node <repo>/scripts/check-icons.mjs                     # 门禁失败路径演示，在隔离副本中
ICON_ALPHA_THRESHOLD=128 node <evidence>/measure-icon.mjs <图标路径…>   # 视觉比例测量；<evidence> = .superpowers/sdd/2026-09-22-app-branding/evidence
```

开发态（每次运行后都对进程组发 SIGINT，并检查残留）：

```bash
npm run dev
cd /tmp && node <repo>/scripts/ensure-electron.mjs && node <repo>/scripts/dev.mjs
plutil -p <repo>/node_modules/.papermind-electron/PaperMind.app/Contents/Info.plist
codesign --verify --deep --strict <repo>/node_modules/.papermind-electron/PaperMind.app
lsappinfo list | grep -i -A2 papermind
ps -Ao pid,ppid,command | grep "PaperMind.app/Contents/MacOS/Electron"
lsof -p <pid> -Fn                                     # 只看路径，不读数据库内容
touch <repo>/electron/main.ts                          # 触发主进程热重启
```

构建与安装包：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run build
mkdir -p /tmp/pm-dmg-verify <copy>
hdiutil attach <repo>/release/PaperMind-0.1.0-arm64.dmg -nobrowse -readonly -mountpoint /tmp/pm-dmg-verify
cp -R /tmp/pm-dmg-verify/PaperMind.app <copy>/
hdiutil detach /tmp/pm-dmg-verify
codesign -dv --verbose=4 <copy>/PaperMind.app
codesign --verify --deep --strict <copy>/PaperMind.app
spctl -a -vv <copy>/PaperMind.app
plutil -p <copy>/PaperMind.app/Contents/Info.plist
open -n <copy>/PaperMind.app
<copy>/PaperMind.app/Contents/MacOS/PaperMind            # 直接执行；修复轮在此实例上 kill -USR1 + CDP 读窗口/isPackaged，再 SIGTERM 退出（evidence/packaged-app-runtime.txt）
lsappinfo list | grep -i -A3 papermind
```

## 六、未验证项与原因

| 未验证项 | 原因 | 由谁完成 |
| --- | --- | --- |
| Dock 视觉比例结论 | 属于主观判断；本机也没有屏幕录制权限取图 | 用户目视 |
| Dock 截图（本地证据） | `screencapture` 返回 `could not create image from display`，缺系统“屏幕录制”权限；未绕过权限 | 用户（授权终端后自行截取） |
| 退出后 Dock 固定项图标 | 需人工把应用从最终安装位置固定到 Dock 再退出观察 | 用户 |
| Windows 开发态与 NSIS 验收 | 无 Windows 设备 | 待有设备时执行 |
| `win.ico` 小尺寸（16/24/32/48 px）在 Windows 上的实际渲染 | 这些尺寸在 ICO 里是 PNG 压缩载荷（`sharp` 实测 7 项全为 PNG），Windows 各 shell 路径对 PNG 载荷的支持不一致；本机无法实测 | 待有 Windows 设备时执行：在图标选择器、资源管理器列表、任务栏等小尺寸位置逐一查看 |
| Linux AppImage 内部 icon 路径与 desktop 文件名 / 安装入口 | 无 Linux 设备；`release/` 无 AppImage，本机也无 `7z`/`unsquashfs` 可提取，文档中的路径与文件名只是按 electron-builder 24 的推断 | 待有设备时执行：`--appimage-extract` 后核对 icon 路径与 `com.papermind.app.desktop`，运行 `desktop-file-validate`，并在含空格的安装路径下执行 `gio launch` |
| 代码签名与公证 | 本机无签名身份，本次范围明确不申请 | 发布流程 |
| 标准拖拽安装到 `/Applications` | 避免改动用户机器上的安装位置（`/Applications` 当前无 PaperMind），改用临时目录验证 | 用户 |

移交说明（不改变任何验收结论）：计划 `docs/superpowers/plans/2026-09-22-app-branding.md` 里 macOS 重签只有一条对外层 bundle 的裸 `codesign --force --sign - --preserve-metadata=entitlements <stagedApp>`；实测这样直接重签会让 `Contents/Frameworks/*` 的签名失效，必须先由内向外逐项重签嵌套项、最后签外层（Task 2 已按此实现并由控制方裁决接受，dev 日志里的 9 行 `replacing existing signature` 即其产物）。在别的机器上重跑该方案时按实现走，不要照抄计划里的裸命令。
