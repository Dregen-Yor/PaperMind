# 跨平台可复现安装与构建设计

日期：2026-11-16

状态：设计已口头批准，待本文档复核

基线：`fbb0b91`（`main`）

## 1. 背景

PaperMind 是包含 Electron、`better-sqlite3` 和 Sharp 原生依赖的桌面应用。当前依赖配置不能证明一次全新检出可以在所有支持平台上稳定执行 `npm ci`：

- `package.json` 中多数直接依赖使用 `^`，manifest 本身没有表达唯一版本；
- lockfile 同时保存 `registry.npmjs.org` 和 `registry.npmmirror.com` 地址，受生成机器的 registry 配置影响；
- `postinstall` 强制运行 `electron-rebuild`，普通安装可能落入本地 C/C++ 编译工具链；
- 本地 `node_modules` 中的 Electron 版本可能与 manifest 和 lockfile 漂移，增量安装掩盖了问题；
- CI 使用 `npm ci --ignore-scripts` 且只运行 Ubuntu，绕过了真实安装生命周期与其他平台的原生模块；
- 发布工作流虽覆盖多个系统，但没有统一校验实际 Node、npm、Electron 和原生模块组合；
- README 仍可能引导普通用户使用会修改依赖树的 `npm install`。

本设计把 `package.json`、`package-lock.json`、工具链版本文件和 CI 共同视为可执行的安装契约。支持声明以干净环境中的真实 `npm ci`、真实 Electron 运行时加载和原生平台发布为证据，而不是以某台开发机已有的 `node_modules` 为证据。

## 2. 目标

- 普通用户从全新源码检出后，只需使用锁定版本的 Node/npm 执行 `npm ci`，不需要 Python、C/C++ 编译器或系统级原生构建工具。
- 所有直接依赖和开发依赖使用精确版本；所有传递依赖由 lockfile 精确锁定。
- lockfile 保留版本与 integrity，但不固化 npm registry 下载域名。
- 支持平台只使用上游发布的预编译原生二进制；缺失时明确判定为不支持，不回退源码编译。
- 在 PR 阶段用四个平台验证真实安装、原生模块、类型检查和源码构建。
- 在发布阶段用四个原生 runner 生成并检查对应安装包。
- README 将 `npm ci` 定义为普通用户唯一的项目依赖安装命令，并单独说明维护者如何显式升级依赖。
- 所有工具链、平台、下载和原生加载失败都提供可操作、不可静默修复的错误。

## 3. 非目标

- 不承诺 Windows 10 与官方矩阵同等级支持；它仅为尽力支持。
- 不在本次工作中完成代码签名、macOS notarization 或 Windows Authenticode。
- 不支持从源码编译 `better-sqlite3`、Sharp 或其他 Node 原生模块作为普通安装的兜底路径。
- 不保证任意 Linux 发行版、musl、32 位系统或未列出的 CPU 架构可用。
- 不允许项目把私人 registry 或 Electron 镜像写死为自动回退地址。
- 不把复用跨系统 `node_modules`、跨架构打包或在 x64 主机模拟 arm64 安装作为受支持方式。
- 不在本设计中升级与安装可复现性无关的业务依赖或修改应用功能。

## 4. 官方支持矩阵

| 平台 | 架构 | 最低版本 | 支持等级 | PR 验证环境 |
| --- | --- | --- | --- | --- |
| Windows | x64 | Windows 11 | 官方支持 | `windows-2025`，验证 Windows x64 ABI；Windows 11 做发布前人工 smoke test |
| Windows | x64 | Windows 10 | 尽力支持 | 不作为阻塞 CI 契约 |
| macOS | x64 | macOS 13 | 官方支持 | `macos-15-intel` |
| macOS | arm64 | macOS 13 | 官方支持 | `macos-15` |
| Linux | x64 | Ubuntu 22.04 或 glibc 2.34 | 官方支持 | `ubuntu-22.04` |

其他 OS/架构组合在安装验证开始时直接报告不受支持。Linux 验证必须同时检查 x64 和 glibc 版本；不得仅凭 `process.platform === 'linux'` 认定受支持。

## 5. 版本契约

### 5.1 工具链

唯一受支持的源码工具链为：

- Node.js `24.22.1`；
- npm `10.9.4`。

版本来源保持一致：

- `.nvmrc` 固定 `24.22.1`；
- `package.json#packageManager` 固定 `npm@10.9.4`；
- `package.json#engines` 不再使用宽范围，而是精确表达 Node 和 npm 版本；
- `.npmrc` 保持 `engine-strict=true`；
- `verify:toolchain` 对实际 `process.version` 和 `npm --version` 做精确比较，并输出 expected/actual；
- CI 安装 Node 后显式准备 npm `10.9.4`，随后再次验证实际版本。

`engines` 是 npm 的第一层阻断，项目验证脚本是稳定错误信息和直接执行脚本场景的第二层阻断。任何版本不一致都必须失败，不得只警告。

Electron 固定为 `44.11.3`。构建安全策略仅批准以下完整运行时元组：

```text
Electron 44.11.3
Node 24.22.2
Chromium 152.0.7977.169
```

这里的 Node `24.22.2` 是 Electron 内嵌运行时，不是执行 npm 的主机 Node。主机安装工具链仍固定为 Node `24.22.1`。构建验证必须区分两者，不能用主机 Node 版本替代 Electron 内嵌版本校验。

### 5.2 依赖 manifest

- `dependencies` 和 `devDependencies` 中的每个版本都必须是精确 semver，不允许 `^`、`~`、通配符、tag 或无界范围。
- Electron 直接依赖更新为精确 `44.11.3`。
- 其他直接依赖先固定到当前 lockfile 已解析的版本，避免本任务夹带功能升级。
- 删除 `@electron/rebuild` 直接依赖以及 `electron-rebuild` 生命周期调用。
- `.npmrc` 添加 `save-exact=true`，防止后续维护命令重新引入范围。
- `verify:manifest` 负责校验上述约束，并检查各版本来源的一致性。

传递依赖继续由 lockfile v3 锁定，不要求手工复制到 `package.json`。

## 6. Registry 中立的 lockfile

项目级 `.npmrc` 定义：

```ini
engine-strict=true
save-exact=true
omit-lockfile-registry-resolved=true
include=optional
```

约束如下：

- 项目不设置 `registry=`；默认使用 npm 官方 registry。
- 用户或组织可在项目之外通过 npm 用户配置、环境变量或代理配置自选兼容 registry。
- 重新生成 lockfile 时，不保存来自默认/配置 registry 的 tarball URL；版本、依赖关系和 `integrity` 仍然保留。
- lockfile 不得包含 `registry.npmjs.org`、`registry.npmmirror.com` 或其他 npm registry 主机名。
- 必须保留平台相关 optional dependency 条目，特别是 Sharp 的 `@img/*` 包；禁止通过 `--omit=optional` 安装。
- Git、文件和非 registry 来源若未来确有必要，必须单独评审；本次依赖树不新增这些来源。

开发者使用自定义镜像生成 lockfile 后，`git diff` 不应因镜像域名不同而产生变化。`npm ci` 必须保持 frozen 行为：manifest 与 lockfile 不一致时直接失败，不自动修改任一文件。

## 7. 原生依赖策略

### 7.1 预编译二进制优先且唯一

`better-sqlite3` 和 Sharp 在支持矩阵内必须使用发布包提供的预编译二进制。安装和验证遵循以下原则：

- 普通安装不运行 `node-gyp`、`electron-rebuild` 或同类编译命令；
- 不探测 Python、Visual Studio Build Tools、Xcode Command Line Tools、GCC 或 Make；
- 预编译包不存在、未下载、ABI 不兼容或加载失败时，给出明确错误后终止；
- 不通过触发源码编译来“自愈”；
- 每个平台独立执行 `npm ci`，不得缓存或上传完整 `node_modules` 给其他 OS/架构复用；
- 可以使用 npm 下载缓存，但缓存键和恢复逻辑不能绕过 `npm ci`。

`better-sqlite3@13.0.3` 当前发布物覆盖目标平台，并且 Linux x64 二进制所需最高 glibc 为 `2.34`，因此 Linux 官方基线取 glibc `2.34`。Sharp `0.34.5` 通过 optional platform packages 提供目标平台预编译文件。

### 7.2 Electron 运行时验证

仅在主机 Node 中 `require()` 原生模块不足以证明 Electron 可用。`verify:native` 应启动项目锁定的 Electron，并通过 `ELECTRON_RUN_AS_NODE=1` 执行最小验证程序：

1. 输出并校验 Electron、内嵌 Node、Chromium、platform 和 arch；
2. 加载 `better-sqlite3`，创建内存数据库并执行最小建表、插入和查询；
3. 加载 Sharp，创建或转换一个最小内存图片并验证输出元数据；
4. 任一步失败时输出模块、平台、架构和实际运行时版本，但不输出用户环境中的敏感配置。

这项验证同时证明 Electron 二进制已准备好、原生模块可被实际 Electron ABI 加载，以及 Sharp 对应平台 optional package 已安装。

## 8. 安装生命周期

普通用户的唯一安装入口为：

```text
npm ci
  → npm engine-strict 检查精确 Node/npm
  → lockfile 安装全部 dependencies/devDependencies/optionalDependencies
  → postinstall 准备官方 Electron 二进制
  → 校验实际 Electron 版本
  → 在真实 Electron 运行时加载 better-sqlite3 与 Sharp
```

`postinstall` 不再调用 `electron-rebuild`，而是调用项目的安装准备脚本。准备脚本：

- 先运行工具链、平台和 manifest 检查；
- 确认 `node_modules/electron` 对应 `44.11.3`；
- Electron 二进制缺失时使用 Electron 官方下载机制；
- 默认不设置镜像；用户可显式通过 Electron 支持的 `ELECTRON_MIRROR` 配置下载源；
- 不包含私人镜像或 `npmmirror` 自动 fallback；
- 下载/代理/TLS 失败时保留根因并提示检查网络、代理或显式镜像环境变量；
- 最后执行真实 Electron 原生模块验证。

安装脚本不得修改 `package.json`、`package-lock.json` 或 `.npmrc`。它可以补齐 npm 包正常应下载的 Electron 二进制，但不得改写依赖解析结果。

## 9. 项目命令接口

`package.json#scripts` 提供稳定入口：

| 命令 | 职责 |
| --- | --- |
| `npm run verify:toolchain` | 精确检查主机 Node/npm 和支持平台 |
| `npm run verify:manifest` | 检查直接依赖精确版本、版本来源一致性、lockfile registry 中立与生命周期约束 |
| `npm run verify:native` | 在实际 Electron 中检查批准运行时、SQLite 与 Sharp |
| `npm run verify:install` | 顺序组合 toolchain、manifest 和 native 验证 |
| `npm run build:source` | 执行类型检查和 renderer/main/preload 源码 bundle，不生成安装器 |
| `npm run build` | 执行完整验证并生成当前平台安装器 |

CI 可直接执行 `npm exec vite build` 作为 renderer bundle 的独立证据，但正式 `build:source` 还必须覆盖 Electron main/preload 构建，避免只验证渲染层。

## 10. PR CI 设计

PR 工作流使用原生四平台矩阵：

```text
ubuntu-22.04    / x64
windows-2025    / x64
macos-15-intel  / x64
macos-15        / arm64
```

每个 job 从干净 checkout 开始，执行：

1. 安装并验证 Node `24.22.1`、npm `10.9.4`；
2. `npm ci`，不使用 `--ignore-scripts`，不省略 optional dependencies；
3. 确认 `package.json`、`package-lock.json` 和 `.npmrc` 没有被安装修改；
4. `npm run verify:install`；
5. 再次记录实际 Electron/Node/Chromium/platform/arch；
6. SQLite 内存查询和 Sharp 最小转换必须通过；
7. `npm run typecheck`；
8. `npm exec vite build`，并执行 main/preload 的构建入口。

完整 `npm test` 和安全策略测试只在 Linux job 运行一次，避免四平台重复执行纯 JS 测试。平台相关安装、native smoke、类型检查和 bundle 仍是四个平台的阻塞检查。

CI 不缓存 `node_modules`。若缓存 npm 下载目录，cache miss 后仍必须完整执行 `npm ci` 和所有安装脚本。

`windows-2025` 能证明当前 GitHub runner 上的 Windows x64 安装与 ABI；它不能替代 Windows 11 桌面交互 smoke test。正式发布前的人工清单需在 Windows 11 x64 启动安装器和应用。

## 11. Release CI 设计

发布工作流同样在原生 runner 上从干净 checkout 执行精确工具链、`npm ci` 和 `verify:install`，然后生成：

- Linux x64 AppImage；
- macOS x64 DMG；
- macOS arm64 DMG；
- Windows x64 NSIS installer。

每个平台只能打包本平台/本架构产物，不共享 `node_modules`。打包后验证：

- 安装包目标 OS/arch 与 job 一致；
- 打包应用内 Electron 版本和批准运行时元组一致；
- `better-sqlite3` 与 Sharp 的目标平台二进制存在且可由打包应用加载；
- 需要从 ASAR 外部加载的原生文件确实位于 `asarUnpack` 输出；
- 每个发布文件生成 SHA-256 校验值并随 artifact 保存；
- 构建日志中不存在源码编译原生模块的步骤。

当前允许发布未签名安装包。README 必须明确：

- macOS Gatekeeper 可能阻止或警告未 notarize 应用；
- Windows SmartScreen 可能警告未知发布者；
- 这是当前发布限制，不应通过让用户关闭系统安全功能来包装成正常体验；
- 签名和 notarization 是独立后续任务。

## 12. README 与维护者工作流

### 12.1 普通用户

README 的源码运行主路径必须是：

```bash
git clone <repository-url>
cd PaperMind
npm ci
npm run dev
```

构建安装包时使用：

```bash
npm run build
```

文档明确解释：

- 必须使用 Node `24.22.1` 和 npm `10.9.4`；
- `npm ci` 会先清理已有 `node_modules`，按 lockfile 重新安装；
- `npm ci` 不更新 `package.json` 或 lockfile；
- manifest 与 lockfile 不一致会直接报错；
- 普通用户不要用 `npm install` 代替项目安装；
- 支持矩阵内不需要安装原生编译环境；
- 自定义 registry、代理或 `ELECTRON_MIRROR` 属于用户本地网络配置，不写入仓库。

README 中所有面向普通用户的依赖安装示例统一为 `npm ci`。现有 `npm install` 示例只有在明确标为“维护者升级依赖”的章节才允许保留。

### 12.2 维护者升级依赖

依赖升级必须显式选择目标版本，例如：

```bash
npm install --save-exact <package>@<explicit-version>
npm ci
npm run verify:install
npm run typecheck
npm test
```

维护者提交 manifest 与 lockfile 的同一变更，并在四平台 CI 通过后合并。不得运行无版本目标的批量升级后直接提交，也不得手工只改 lockfile 中的版本。Electron 升级还必须单独核验并更新批准的 Electron/Node/Chromium 完整元组。

## 13. 失败行为

所有错误都以非零退出码结束，并满足以下信息契约：

- 工具链错误：显示 Node/npm 的 expected 与 actual，以及对应版本文件；
- 平台错误：显示 OS、arch；Linux 额外显示检测到的 glibc，并列出支持矩阵；
- lockfile 错误：说明 manifest/lock 不一致或 registry host 违规，不自动运行 `npm install` 修复；
- Electron 下载错误：保留网络错误类别，提示代理、registry 或 `ELECTRON_MIRROR`，不切换私人地址；
- Electron 版本错误：显示 package 声明、lockfile、已安装包和实际二进制版本；
- Sharp 错误：指出缺失或不兼容的 `@img` optional package，并确认没有使用 `--omit=optional`；
- SQLite/Sharp 加载错误：显示 platform、arch、Electron、内嵌 Node 和模块版本，明确“不进行源码编译回退”；
- 安全运行时错误：显示实际 Electron/Node/Chromium 元组和唯一批准元组并阻止构建；
- 安装后文件变化：列出被意外改写的依赖契约文件并失败。

错误消息必须稳定、可测试、可供 CI 日志检索，不输出 token、代理凭据、用户目录中的秘密或完整环境变量。

## 14. 测试策略

### 14.1 静态契约测试

- 所有直接依赖是精确 semver；
- Node、npm、Electron 版本在 `.nvmrc`、manifest、脚本和 CI 中一致；
- lockfile 不含 npm registry 主机，仍包含 integrity；
- lockfile 包含四个目标平台需要的预编译/optional 包条目；
- `.npmrc` 强制 exact save、registry-neutral lock 和 optional dependencies；
- 生命周期脚本不含 `electron-rebuild`、`node-gyp` 或源码编译 fallback；
- 安装和下载代码不含私人镜像或自动镜像 fallback；
- Electron 批准元组精确且非空；
- README 普通用户路径只使用 `npm ci`。

### 14.2 行为测试

- 错误版本、未知平台、Linux glibc 过低都会在下载或构建前失败；
- manifest/lock 不一致时失败且两个文件保持不变；
- 缺少 Electron 二进制时走官方准备路径；显式 `ELECTRON_MIRROR` 能被上游机制尊重；
- Electron 下载失败不尝试私人 fallback；
- 缺失 Sharp optional package 时错误具有针对性；
- 实际 Electron 中 SQLite 内存查询和 Sharp 转换成功；
- 非批准 Electron 运行时阻止源码构建和打包；
- `npm ci` 前后依赖契约文件 hash 不变；
- 所有诊断包含约定字段且不泄漏敏感值。

### 14.3 CI 与发布验证

- 四平台 PR job 都从空 `node_modules` 执行真实 `npm ci`；
- Linux 执行完整 Vitest 和安全测试；
- 四个平台都完成 renderer、main 和 preload bundle；
- 四个 release job 生成预期格式并完成 runtime/native/ASAR/SHA-256 验证。

## 15. 验收标准

实现完成必须同时满足：

1. 四个官方矩阵环境从全新检出执行 `npm ci` 成功。
2. `npm ci` 前后 `package.json`、`package-lock.json` 和 `.npmrc` 完全不变。
3. 普通安装不需要也不调用 Python、C/C++ 编译器或平台原生构建工具。
4. 实际主机 Node/npm 与声明的精确版本一致。
5. 实际 Electron/Node/Chromium 与批准运行时元组一致。
6. `better-sqlite3` 和 Sharp 在真实 Electron 进程中完成最小功能测试。
7. renderer、Electron main 和 preload 在四个平台都构建成功。
8. Linux job 的完整单元测试与安全策略测试通过。
9. release workflow 生成 Linux AppImage、macOS x64 DMG、macOS arm64 DMG 和 Windows x64 NSIS。
10. 每个发布产物通过 runtime、native module、ASAR unpack 和 SHA-256 检查。
11. README 对普通用户只引导 `npm ci`，并清楚说明精确工具链、支持矩阵与未签名限制。
12. 所有不支持或不一致状态都明确失败，提供 expected/actual 诊断，且不静默修改文件、换镜像或源码编译。

## 16. 预计实现边界

实现阶段预计只触及安装、构建、测试和文档边界：

- `package.json`、`package-lock.json`、`.npmrc`、`.nvmrc`；
- `scripts/` 中 Electron 准备、工具链/manifest/native/install 验证脚本；
- 运行时安全配置及其测试；
- `.github/workflows/ci.yml` 和 release workflow；
- Electron Builder 的 `asarUnpack`/目标配置（仅在验证发现必要时调整）；
- README 和与开发安装命令直接相关的贡献文档。

实现不得借机修改业务代码、Docling 架构、UI 或数据模型。若某项原生依赖的已发布二进制无法满足本矩阵，应停止并重新评审依赖版本或支持矩阵，而不是扩大为本地编译方案。

## 17. 风险与后续工作

- 上游预编译包可能在未来版本撤回某个平台；每次原生依赖升级都必须重新跑四平台矩阵。
- GitHub runner 标签会随平台供应变化；标签迁移必须保持相同 OS/arch 语义并重新验证。
- 未签名安装包会影响终端用户信任和安装体验；后续应单独引入密钥管理、macOS notarization 和 Windows 签名。
- Windows 11 的桌面 smoke test 当前是人工发布门槛；未来可在合适的 Windows 11 runner 可用后自动化。
- registry-neutral lockfile 降低镜像绑定，但不能保证任意第三方镜像内容完整或及时；integrity 校验继续作为内容一致性边界。
