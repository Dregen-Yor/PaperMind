# 2026-10-22 运行时安全加固记录

本次针对 [Node.js 2026-10-21 安全公告](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) 加固。此记录不代表 Electron 已包含全部修复，也不代表依赖漏洞审计通过。

## 当前状态

- 开发与构建基线固定为 Node.js **24.22.1 LTS**，`.nvmrc`、npm engines、安装检查和 CI 使用同一基线。22/26 分支修复下限分别为 22.23.4 / 26.12.1，但本项目开发构建统一使用 24 分支。
- 本机从官方发行目录下载并按官方 SHASUMS256 校验了 Linux x64 归档，SHA256 为 `6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6`。安装在 `~/.local/share/papermind-runtimes/node-v24.22.1-linux-x64`，已有 PATH 中的 `~/.local/bin/node` 指向它。当前 shell 的 Node 为 24.22.1；系统 `/usr/bin/node` 仍为 26.11.1，其他绕过该 PATH 的服务不在此次修复范围内。
- Electron 从浮动依赖改为精确版本 **44.9.3**。实际执行文件报告内置 Node **24.22.0**、Chromium **152.0.7977.167**，仍低于本批 Node 安全修复下限。
- `config/runtime-security.json` 的 Electron 批准列表因此保持为空。`npm run security:runtime`、`npm run build` 与 release 工作流会失败关闭；禁止产生或发布被误认为安全的新安装包。builder 的 `afterPack` 还会检查实际安装包可执行文件，不能只凭 package.json 放行。
- 现有 `release/linux-unpacked/com.papermind.app` 为 Electron 44.2.0 / Node 24.20.0，仍受影响。没有修改、覆盖或删除历史产物。

## 已落实的边界

Docling 在使用原生 Node fetch 前检查实际运行时；当前 Electron 会在联网、建立隧道前拒绝新解析与连接测试。已有本地解析结果仍可读取。PDF 上传上限 64 MiB，解压后的 JSON 响应上限 64 MiB，最多两个同时请求，保留请求超时和隧道连接期限。

对话、视觉摘要、摘要服务和 benchmark 客户端禁止自动重定向，避免跨站转发凭据。配置地址在 URL 规范化前验证，拒绝混淆 IP、嵌入凭据和远端明文 HTTP；本机 `localhost` / `127.0.0.1` / `::1` 可供 Node 端服务使用。浏览器 CSP 只允许 localhost / 127.0.0.1 的明文连接（Chromium 不接受 IPv6 字面量 CSP host-source）；界面直连本机模型请使用前两者。标准模型响应与流式响应按解压后字节限制为 32 MiB；benchmark 请求缺省超时为 300 秒。

所有数据库和应用 IPC handler 在分发前验证来源：必须是当前应用窗口的主 frame，且 URL 与应用入口完全一致（忽略路由 hash）。远程网页、子 frame 和未知 sender 不能调用。主窗口显式启用 sandbox、context isolation、web security，禁用 Node integration 和 webview。打包版本忽略开发服务器环境变量。CSP 保留 PDF 自定义协议、worker、WASM 和本地模型资源的必要访问，禁止 eval、内联脚本、对象和嵌入 frame。

CI 与 release 使用锁定提交的 Actions，并禁用 checkout 凭据持久化；仅发布 job 保留写入 release 所需权限。

## 验证结果

- `npm test`：164 个 Vitest 测试文件、2069 项测试，以及 24 项 Node 脚本测试全部通过。覆盖版本下限、未知版本、实际执行文件冒充、afterPack 拒绝及不生成批准证明、URL 混淆、字节上限、并发释放和 IPC 来源。
- `npm run typecheck`：通过。
- `npx vite build`：前端、Electron main 和 preload 构建通过。此命令仅验证代码打包，不生成或批准安装包。
- 真实 HTTP 服务测试：Docling 遇到 302 时没有请求凭据接收端。
- 真实 Electron 44.9.3 隔离临时 profile smoke：沙箱 preload 桥接可用、renderer 无 process、`papermind-paper:` fetch 可用、eval 被 CSP 拒绝。未使用用户数据库。
- 在真实 Electron 内运行 Docling 客户端：确认 Node 24.22.0 在 fetch 和隧道前被阻止。
- `npm run build`：预期退出 1；实际检测到 Electron 44.9.3 / Node 24.22.0，拒绝打包。
- `npm audit --registry=https://registry.npmjs.org --json`：审计端点 socket hang up，无法取得结果；不得解释为零漏洞，未执行强制升级。
- 上述为本地验证结果；远程 CI 结果以对应 PR 为准。macOS / Windows 产物未在本机验证。

## 后续解除发布阻断

先核实 Electron 官方维护版本的本批修复公告与实际内嵌版本，再精确更新 Electron 依赖和 lockfile。将经核验的 Electron / Node 精确版本对及官方修复证据 URL 写入批准列表，重新执行完整测试、真实应用兼容检查及每个平台的安装包检查。不能仅添加允许名单或升级系统 Node 来声称 Electron 修复完成。当前没有提供跳过门禁的环境变量。
