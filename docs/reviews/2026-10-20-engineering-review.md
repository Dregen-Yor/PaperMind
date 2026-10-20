# PaperMind 工程架构与实现审查报告

## 文档归档说明与后续修复状态

状态更新：2026 年 10 月 20 日；本轮验证基线为 `main @ 7efa9ad03fac2980b3f4dd2df6059773954ae83a`；修复状态包含本报告随附的整改代码。本文件于同日由原始 HTML 审查报告完整转换为 Markdown。正文保留审查时的结论、复现记录、优先级和代码定位；这些内容针对 `main @ 54d1b98bbc3fd56b5c034b6b10f61706135212c2`，不应直接视为当前版本仍存在的全部问题。正文中的“只读”“未执行修复”等表述描述的是原始审查阶段。

审查后三次修复已合并：[PR #3](https://github.com/xmdjy/PaperMind/pull/3) 处理数据库一致性，合并提交为 `d0bbfbc7856348828658ec125aaf84c6fa37fd2d`；[PR #4](https://github.com/xmdjy/PaperMind/pull/4) 处理会话草稿／上下文归属和缺失 PDF 补回，合并提交为 `15011f1cf88254e94413a31495aeea6eaa7b6d65`。

[PR #5](https://github.com/xmdjy/PaperMind/pull/5) 处理导入批次及笔记高亮同步，合并提交为 `7efa9ad03fac2980b3f4dd2df6059773954ae83a`。该次新增 42 项测试，最终 143 个文件、1881 项 Vitest 测试及 19 项脚本测试通过，类型检查、Vite 打包、独立审查与 PR CI 通过；原生 Electron 实机验收未完成。

| 原始编号 | 后续状态 |
| --- | --- |
| F01：恢复备份的数据库与 PDF 不一致 | 已修复：增加文件暂存、日志、SQL 提交标记、失败回滚和启动恢复。 |
| F02：缺失 PDF 时复用同 ID 旧文件 | 已修复：缺失原文会清除旧文件，避免元数据与旧 PDF 错配。 |
| F03：备份设置未经 JSON 和结构校验 | 已修复：导入前验证 JSON 及已知配置结构，错误时拒绝导入。 |
| R04：删除知识库／清空数据先删文件 | 已修复：相关操作使用同一套可恢复文件事务，并在启动时处理未完成批次。 |
| F05：会话切换后携带旧划选上下文 | 已修复（PR #4）：问题草稿与划选原文按会话隔离，切页面后可恢复，异步发送固定目标并保护后续编辑。草稿保留范围是当前应用运行期间。 |
| F07：笔记与 PDF 高亮副本不同步 | 已修复（PR #5）：两面板读取按论文隔离的同一数据源，修改后更新覆盖层，旧读取不能覆盖已完成的修改。 |
| F09：导入批次目标漂移 | 已修复（PR #5）：共享队列按批捕获文件和目标，进度跨路由保留，目标不存在时明确报错。并修复体验报告 U06 连续导入漏文件。 |
| F04、F06、F08、F10–F13 | 本轮交付已修复：流协议终止判断、摘要运行管理、Ollama 温度、跨页定位、PDF 清理、产品评测入口与 Windows 产物命名。 |
| 其余设计风险 | 保留长期评估项，不将有限回归测试视为所有架构风险已消失。 |

PR #3 同时增加单实例保护、导出前恢复、大小写不敏感文件系统的 ID 冲突保护等配套措施。该次交付时验证结果为 137 个测试文件、1792 个 Vitest 测试及 19 个脚本测试通过，类型检查、Vite 打包及 PR CI 通过；Windows／macOS 安装包未做实机验收。修复机制及边界见 [数据库恢复说明](../testing/database-recovery.md)。以下正文中的 1639 个测试等数字属于原始审查基线，与修复后的验证结果分开记录。

PR #4 另新增阅读页补回原始 PDF 和同哈希重新导入修复，保留原论文及关联内容；补回要求可信原文件指纹。该次新增 47 项回归测试，最终 140 个文件、1839 项 Vitest 测试及 19 项脚本测试通过，类型检查、Vite 打包、PR CI 和独立审查通过。体验问题的逐项状态与剩余原因见 [使用体验审查](2026-10-20-user-experience-review.md)。这些交付结果与下文原始审查数据分别记录。


## 本轮工程整改结果

原始 13 项 F 编号中，前几轮已合并修复 6 项，本轮完成其余 7 项；原始复现保留在下文，均不能再直接当作当前缺陷。原始 10 组设计风险中 R04 已修复，其余为长期评估清单，不属于这 13 项明确问题的关闭统计。

| 编号 | 本轮结果 | 明确边界 |
| --- | --- | --- |
| F04 | 共享 provider 流解析器检查 terminal／error／EOF，处理尾部缓冲、UTF-8 与取消，异常保留部分回答并显示失败。 | 单测和流协议 fixture，不是全部真实服务端协议兼容认证。 |
| F06 | 摘要建立运行锁、助手占位、取消与正确轮次的重试／续写，跨页重入不再重复同一会话运行。 | 共享 Docling 准备可继续为其他消费者完成缓存；取消当前会话不会假称终止共享生产者。摘要面板与聊天主动同时生成时各自持有模型任务。 |
| F08 | Ollama 请求包含合法化 temperature；maxTokens=0 仅省略 num_predict。 | 参数发送测试不保证 provider 必然遵从。 |
| F10 | 保留字符 provenance，句子引用映射真实页；缺映射时展示真实跨页范围，链接／Markdown／事件／路由均保留 endPage。 | 已存旧摘要不静默重写，重新生成后采用新映射；旧解析缓存可降级为范围。 |
| F11 | 真正持有并销毁 loadingTask；成功、加载失败、裁剪失败和取消均清理。 | 长时间原生内存稳定性仍需实机压力验证。 |
| F12 | 新增 `npm run bench:product`，真实复用 E-k5／RAG／Docling 生产算法；旧 runner 标注 legacy，保留历史结果。 | 离线 smoke 为合成 PDF／假向量／固定输出；真实入口需要预置模型与显式服务配置，未运行真实质量评测。支持范围和 Node／WASM差异见 bench/README.md。 |
| F13 | Windows 命名改用 APP；在临时目录执行实际发布重命名脚本验证三平台文件名。 | 未发布版本或在三平台运行安装器。 |

全量 152 个文件、1979 项 Vitest 测试与 19 项脚本测试通过，类型检查及独立审查通过；构建、CI、浏览器验证与后续运行状态见 [本轮验证记录](../testing/review-completion.md)。体验 16 项和 4 项补充能力的详细结果见 [体验审查](2026-10-20-user-experience-review.md)。

---

审查日期：2026 年 10 月 20 日　｜　基线：main @ 54d1b98bbc3fd56b5c034b6b10f61706135212c2<br>仓库：/home/xmdjy/cs/PaperMind　｜　方式：3 个 subagent 分域审查，主 agent 交叉复核与验证

PaperMind 已具备清晰的桌面应用骨架和较完整的局部测试，但功能演进后的跨模块契约没有同步收敛。主要问题集中在数据恢复的跨资源一致性、会话与任务的状态所有权、证据页码的真实性，以及评测对象与正式产品路径分离。建议先修正确性边界，再逐步拆分职责；目前没有证据支持整体重写。

本报告识别出 **13 项可定位的问题与工程缺口：P1 共 3 项、P2 共 9 项、P3 共 1 项**，另列 10 组设计风险与演进债务。P1 优先处理数据损失、会话串线及错误完成态；P2 是明确功能偏差或关键质量保障缺口；P3 是交付与维护问题。这里的等级是整改优先级，不是安全漏洞评级。没有发现足以确认的 P0，也不据此保证不存在其他缺陷。

[范围与证据](#scope) · [实际架构](#architecture) · [问题清单](#findings) · [设计风险](#risks) · [验证与盲区](#tests) · [整改路线](#roadmap) · [代码索引](#appendix)

<a id="scope"></a>

## 一　范围与证据

本次阅读了应用入口、Electron 主进程与 IPC、preload 与共享契约、SQLite schema 和主要 repositories、全部五类路由页面、核心组件、两个 Pinia store、网页 composables，以及 PDF、E-k5、Docling、RAG、模型请求和 benchmark 的主要调用路径；同时检查 README、模块 CLAUDE 文档、相关设计方案、测试和 CI／Release 工作流。审查以当前可执行代码为事实，以文档与设计方案作为意图对照，避免用已经过时的文档判定新实现错误。

| 审查分工 | 覆盖内容 | 证据方法 |
| --- | --- | --- |
| 主 agent | 全局架构、模块契约、产品与评测差异、流式解析、工程交付与结论复核 | 类型检查、全量测试、Vite 构建、真实源函数定向探针、前端探针复跑 |
| Electron subagent | 主进程、数据库、迁移、备份、PDF 文件、预览隔离、Docling 接入 | 实际数据库模块内存打包，临时 userData，文件故障注入 |
| 前端 subagent | 路由、Pinia、阅读器／聊天／笔记交互、网页问答、异步切换与取消 | 组件与 store 定向测试，跨组件调用链追踪 |
| 检索 subagent | 解析、索引、来源、缓存、摘要、检索与 benchmark | 合成文档与确定性向量探针、本地库接口核验、调用路径检查 |

**证据分类：**“动态复现”表示用当前模块或当前源函数在隔离输入下重现；“静态确认”表示已追踪到直接决定行为的代码分支；“设计风险”表示有明确成因，但未测得生产环境中的发生率或损失。没有调用真实付费模型、SSH 主机或 Docling 服务，没有做整套桌面端人工验收、安装包跨平台运行测试或真实论文大规模效果评测。

仓库始终保持只读：未改产品代码、未切换分支、未提交或推送。临时测试、构建结果与本报告放在仓库以外；构建生成的 Electron 输出属于忽略产物。最终 Git 工作区仍干净。

<a id="architecture"></a>

## 二　当前实际架构

| 层 | 当前职责与代码 | 主要判断 |
| --- | --- | --- |
| 界面 | Vue 3；LibraryView、ReaderView、ChatView、SettingsView、WebPreviewView；hash router | 页面组织清楚；部分交互状态属于组件实例，业务对象切换后没有重新归属。 |
| 业务编排 | Pinia paper/chat；useWebQa、useWebPageHistory | chat store 同时承担配置、HTTP、流解析、检索、摘要和运行持久化；不同功能的任务契约分裂。 |
| 算法与文档 | src/utils 中 PDF.js、E-k5、Docling 归一、RAG、来源与 Markdown | 当前产品与旧实验路径共存；来源粒度在部分跨页转换时丢失。 |
| 跨进程 | preload → TypedInvoke → ipc.ts → repositories／预览控制器 | 共享编译期契约是优点；发送者与运行时数据校验尚不统一。 |
| 持久化与系统 | better-sqlite3，WAL／外键，16 张表；userData/papers 中独立 PDF；模型权重另有 IndexedDB 缓存 | SQL 事务不能覆盖独立文件操作，恢复和删除缺少可恢复的整体协议。 |
| 服务与评测 | renderer 直连 LLM；main 调 Docling；bench 有独立 LLM 客户端与历史算法矩阵 | 本地优先但摘要含远端解析；bench 当前不验证正式 E-k5／Docling 质量链。 |

### 1　导入与阅读

```text
选择 PDF → parsePdfMeta 提取元信息／计算哈希 → 去重
→ paperStore.addPaper → IPC → 写 PDF 文件＋SQLite 元数据
→ 后台 indexPaper → E-k5 完整索引写入

ReaderView → paperContentUrl → papermind-paper 协议
→ PDF.js → 页面布局、近邻 canvas／text layer 渲染、远页回收
→ 划选文本 → ChatPanel.pendingContext → 下一问题 externalContext
```

paper store 不长期保存 PDF base64；阅读器已有文档代次、旧渲染任务取消及加载结果保护。需要修的是高亮事实源和 composer 归属，而非否定这些已有生命周期控制。

### 2　正式论文问答

```text
用户消息持久化 → assistant preparing 占位 → 会话级 ActiveChatRun
→ 等待本地向量模型和 E-k5 索引
→ PDF 原生 outline／目录页／排版标题形成章节树
→ 叶子章节完整正文组
→ 标题路径向量＋路径／正文 BM25 → 等权 RRF(k=60) → 每篇 top-5
→ 多篇合并并检查字符预算 → 参考内容＋最近历史＋系统提示
→ 当前 LLM 流式生成 → 定时保存部分正文 → 最终状态落库
```

有划选 externalContext 时直接使用划选原文，跳过论文收集与检索；多轮问题可能调用 LLM 改写。产品当前固定 E-k5，语义树不是设置可切回的默认产品路径。默认参考上限为 120000 字符，多篇共用，超限拒绝，不截断章节；这是字符预算，不是整次请求的 token 预算。

### 3　论文解读与摘要

```text
/abstract 或论文摘要面板
→ 主进程 Docling facade：PDF／配置指纹 → 命中缓存或远程解析
→ renderer 用 PDF.js 补图片／表格／公式截图 → 本地素材持久化
→ 原文句子编号 → 分段提炼／归约／checkpoint
→ 当前聊天模型生成 → materializeAbstract 验证素材与引用 ID
→ PaperAbstract 缓存／聊天消息 → 图片及来源跳转
```

这条链已取代旧 HuggingFace T5 生产摘要；但它没有复用普通对话 ActiveChatRun。Docling 默认地址会触发固定 SSH 转发，这一点 README 已披露，不能描述成隐蔽上传。

### 4　网页问答与归档

```text
显式打开网页 → 隔离的原生 WebContentsView
→ HTML／原貌归档 → immutable snapshot → 会话绑定 snapshotId
→ 完整快照＋已完成历史＋问题 → LLM
→ assistant completed／failed／cancelled 持久化
```

网页控制器使用 selectionVersion 和 AbortController 隔离切换，页面离开会停止问答并关闭预览；缓存预览限制脚本和网络。网页刷新后继续针对旧快照回答有界面提示，是明确设计，不作为“答错新网页”的独立缺陷。

### 5　已有设计中值得保留的部分

- 共享 IPC 类型和 handlers 的 satisfies 校验，减少通道与参数签名漂移。
- SQLite 外键／级联清理、部分迁移事务、网页快照指纹与引用校验。
- 普通论文问答的助手占位、取消、部分输出保存和运行恢复机制。
- E-k5 合并同篇并发加载、完整构建后替换旧索引、损坏或旧索引重建、不静默改用另一种检索。
- 主窗口 contextIsolation、禁用 Node 集成、导航与新窗口拦截；网页预览独立 session 和权限拒绝。
- PDF 协议按 ID 解析受管文件，并检查路径／symlink 逃逸；导出默认脱敏模型与 Docling 凭据。

<a id="findings"></a>

## 三　问题清单与整改建议

| 编号 | 优先级 | 问题 | 证据 |
| --- | --- | --- | --- |
| F01 | P1 | 恢复备份在 PDF 写入前提交数据库，失败后不能回滚 | 数据库故障注入复现 |
| F02 | P2 | 缺失 PDF 的备份沿用同 ID 旧文件，原文与元数据错配 | 数据库复现 |
| F03 | P2 | 备份设置未校验 JSON，可导入成功后初始化失败 | 数据库复现 |
| F04 | P1 | 产品流式解析将非正常终止判为成功，并丢末尾无换行记录 | 当前源函数复现 |
| F05 | P1 | 对话切换后携带上个会话划选上下文，跳过新会话论文检索 | 真实组件复现并复跑 |
| F06 | P2 | /abstract 绕过会话运行锁、取消与助手占位，允许乱序轮次 | store 复现并复跑 |
| F07 | P2 | 笔记面板删除高亮后，PDF 私有副本仍显示并阻止重新高亮 | 跨组件静态确认 |
| F08 | P2 | Ollama 温度设置未进入请求 | 请求体复现并复跑 |
| F09 | P2 | 批量导入期间切知识库会改变本批文件目标 | 异步数据流静态确认 |
| F10 | P2 | 跨页摘要句子引用被固定定位到第一页 | 文档合成输入复现 |
| F11 | P2 | Docling 补截图调用不存在的 PDF 销毁接口 | 本地 API 核验及探针 |
| F12 | P2 | benchmark 未覆盖当前正式 E-k5 和 Docling 摘要 | 产品／评测调用链确认 |
| F13 | P3 | Windows 发布文件名使用未定义的 app 小写变量 | 工作流静态确认 |

<a id="F01"></a>

### F01　恢复备份并不具备整体原子性 P1 · 动态复现

electron/db/index.ts:426、427、499、502、504；src/views/SettingsView.vue:417、420

**意图与实现：**用户执行覆盖恢复，失败应保有可用的原数据或可明确恢复到一致状态。当前 importAll 先在 SQLite 事务中删除旧数据并插入备份，调用 insert() 提交；之后才 writeFileSync 写各篇 PDF。此后磁盘空间不足、权限变化或 I/O 错误，都无法回滚已经提交的数据库。

**复现：**用临时 userData 装入旧论文 same，对新备份的 PDF 写入注入 ENOSPC。importAll 抛错，但查询只剩新记录 new；旧 same.pdf 仍在，新 new.pdf 不存在。输出为 `AFTER_FAILURE_ROWS ['new']; OLD_FILE_PRESENT true; NEW_FILE_PRESENT false`。

**影响：**UI 显示“导入失败”，旧库却已替换；若中途有同 ID 文件成功覆盖，正文也可能部分新、部分旧。界面失败路径不刷新，内存态还可能与数据库不一致。

**建议：**PDF 先写独立暂存目录，完整验证；保留旧库／旧文件恢复点，通过可恢复的文件切换协议和数据库提交协调，并为中途崩溃提供 journal 恢复。仅把 writeFileSync 搬进 SQL transaction 不能实现文件回滚。验收应注入第 1／第 N 文件写入失败、权限错误与进程中断。

<a id="F02"></a>

### F02　缺失 PDF 的恢复会静默复用旧原文 P2 · 动态复现

electron/db/backupValidation.ts:216；electron/db/index.ts:378、440、503、509

exportAll 在原 PDF 缺失时合法输出 fileData:null；导入也接受 null。importAll 仍将 file_path 设为 papers/<id>.pdf，只在 fileData 是字符串时写文件，清理阶段则按 ID 保留目标文件。因此同 ID 的恢复前 PDF 会被当作恢复后的正文。

**复现：**same.pdf 初始为 OLD_PDF，导入同 ID、标题 RESTORED_WITHOUT_BYTES、fileData:null。标题已替换，readFile('same') 仍返回 OLD_PDF，导入成功。

**影响与建议：**元数据、索引和阅读正文可能来自不同内容。缺失原文应显式建模并隔离旧文件；若支持复用，必须核验可信内容哈希，不能只比较 ID。补充“原文缺失＋目标同 ID 文件存在”的往返测试。

<a id="F03"></a>

### F03　备份中的坏设置可通过校验并破坏初始化 P2 · 动态复现

electron/db/backupValidation.ts:265；electron/db/index.ts:288、494；src/stores/chat.ts:467；src/App.vue:79

校验器只要求 settings.value 是字符串；入库原样保存，读取时直接 JSON.parse。包含 `{key:'llm_profiles',value:'not JSON'}` 的备份导入成功，之后 settings.get 抛 SyntaxError。App 的 store 初始化会经过该键，成功导入后的刷新反而暴露持续失败。

这不意味着必然整个窗口白屏，但聊天配置和初始化后续步骤会受影响。应在任何覆盖写入前解析所有设置 JSON，再对 profiles、Docling 和检索限制等关键键做结构校验；读取侧也应能定位损坏键并提供恢复路径。有效 JSON 的错误结构也应测试。

<a id="F04"></a>

### F04　流式回答的“完成”判据过弱 P1 · 源函数复现

> 当前状态：本轮交付已修复；以下保留原审查基线的现象、证据和建议。

src/stores/chat.ts:278、298、305、313、333、348、367、377；完成态写入见 :1383、1392。对照 bench/src/streaming/openaiSse.ts:107、ollamaNdjson.ts:98。

产品三种流解析器以 reader EOF 和已有非空内容作为成功条件。OpenAI 不要求终止标记；Ollama 不要求 done:true；Anthropic 只读取文本和 stop_reason，忽略 error 事件。JSON 解析失败也直接跳过。网络／代理以正常 EOF 提前结束，或服务先输出正文再发错误事件时，部分答案会被返回为 `truncated:false` 并标记 completed。

```text
当前源码函数的无网络输入与结果：
OpenAI：一条 partial delta，没有 finish／DONE → {content:"partial",truncated:false}
Anthropic：partial 后接 overloaded_error 事件 → {content:"partial",truncated:false}
Ollama：partial，没有 done:true → {content:"partial",truncated:false}
Ollama：完整 done:true JSON，但末尾没有换行 → 错误“模型返回了空响应”
```

**影响：**用户看到不完整的答案却没有失败／续写提示；合法末条 NDJSON 也可能被丢弃。以上是提取并转译当前真实源函数的协议探针，不是远端服务端到端测试。

**建议：**做共享的 provider 流解析模块，明确 terminal、error、EOF、尾部 buffer 和部分正文规则，分别定义 OpenAI／Anthropic／Ollama 终止条件。保留已有部分正文但将异常终止落为 failed／interrupted；接入 benchmark 已有的严格解析经验，避免维护两套不同正确性标准。

<a id="F05"></a>

### F05　会话切换没有重新归属 composer 状态 P1 · 组件复现（已修复）

> 当前状态：PR #4 已修复会话草稿与划选原文串线。以下内容保留原审查基线的复现过程和建议，不表示该 bug 在当前版本仍然存在。

src/components/ChatPanel.vue:119、131、133、151、200、211、214；src/views/ChatView.vue:133；src/views/ReaderView.vue:64；src/stores/chat.ts:1324、1359

input、pendingContext、loading 由 ChatPanel 实例持有，conversation prop 改变时没有按会话清空或保存。真实组件测试执行 A.addContext → setProps(B) → 在 B 输入问题并发送，实际调用 `sendMessage('B','B question','A confidential selected text')`。父层复用 ChatPanel，因此这条输入路径实际可达。

**影响：**B 的回答会使用 A 的原文；externalContext 非空还会使 B 的论文收集／检索直接跳过。A 的 loading 可继续阻塞 B，完成回调又读取当前 props.id 去自动命名。send 在 await scrollToBottom 后才读取会话 ID，也扩大了目标漂移窗口。

**建议：**draft／context 按 conversationId 归属，或给 composer 使用会话 key 重建；运行状态由 store 提供。每次发送在第一次 await 前冻结 conversationId 和输入快照，所有回调只使用快照 ID。补测切会话、切论文、A 生成中转到 B、完成回调和失败后草稿归属。

<a id="F06"></a>

### F06　摘要没有接入统一的会话运行生命周期 P2 · store 复现

> 当前状态：本轮交付已修复；以下保留原审查基线的现象、证据和建议。

src/stores/chat.ts:1150、1234、1421、1424、1433、1441、1459、1483

普通消息使用 startingChatRuns／activeChatRuns、助手占位和 AbortSignal；命令分支 /abstract 不建立对应运行锁，也不预留助手消息。组件 local loading 只约束同一次挂载；离页重入后失效。

**复现：**让 /abstract 等待返回，此时 stopConversationRun 返回 false，再发 /unknown 被接受。最终顺序是 `user /abstract → user /unknown → assistant 未知命令 → assistant 摘要`。测试通过表示缺陷被重现，不代表行为正确。

重试／继续通过“助手前最近用户消息”配对，乱序后还可能重放错误问题。建议全部命令统一到会话运行管理器：预留助手、记录 runId、锁住同会话、透传取消和 checkpoint，区分共享论文摘要缓存任务与某个聊天轮次。先补普通提问与摘要交错、重入、停止、重试配对测试。

<a id="F07"></a>

### F07　笔记与 PDF 高亮各自保存事实副本 P2 · 静态确认

> 当前状态：PR #5 已合并修复，提交为 `7efa9ad03fac2980b3f4dd2df6059773954ae83a`。以下保留原审查基线的现象和定位。

src/components/NotesPanel.vue:56；src/stores/paper.ts:92、102；src/components/PdfViewer.vue:107、119、164、680、706；src/views/ReaderView.vue:24、66

NotesPanel 删除后只改数据库和 paperStore.highlights；PdfViewer 使用私有 highlights ref，只在 loadDocument 时从数据库读取，没有订阅 store 变化。笔记显示时 PDF 仍挂载，所以黄块和 hitRegions 继续存在，缩放也会根据旧列表重画；subtractExisting 仍扣掉旧范围，导致刚删除的选区不能立即重新高亮。

应将高亮按 paperId 建为唯一响应式数据源，viewer 从该源派生当前页绘制数据；或至少建立明确的变更通知与同步。只验证 PDF 自身取消／恢复按钮不足，需同时挂载笔记与 PDF，测双向添加、删除、恢复及切论文。

<a id="F08"></a>

### F08　Ollama 的温度参数只保存在 UI P2 · 请求体复现

> 当前状态：本轮交付已修复；以下保留原审查基线的现象、证据和建议。

src/stores/chat.ts:625；src/components/ParamPanel.vue:39；src/views/SettingsView.vue:183

UI 对 Ollama 显示且持久化 temperature，但构造 options 时只写 top_k、num_predict。设置 temperature=1.7 后的实际请求体没有 options.temperature，仍由服务端默认值决定采样。

应为 Ollama 发送合法化后的 temperature，并建立 provider 请求参数契约测试。要区分“UI 保存成功”“请求真正发出”和“provider 是否遵从”，本次确认的是第二步遗漏，没有推测某个真实服务的输出随机性。

<a id="F09"></a>

### F09　批量导入没有冻结批次目标 P2 · 静态确认

> 当前状态：PR #5 已合并修复，提交为 `7efa9ad03fac2980b3f4dd2df6059773954ae83a`。以下保留原审查基线的现象和定位。

src/views/LibraryView.vue:297、304、309、314、319、336

onFilesSelected 在解析每个文件、等待去重确认后才读取 activeKbId.value 作为保存目标。用户从 A 开始导入，在等待阶段切到 B，后续论文就保存到 B；同一批次可能分散到多个知识库。

同时循环长度和 item 来自可被下一次文件选择覆盖的 importItems，缺少独立批次对象和运行锁。第二次选择导致具体损坏程度尚未动态复现，作为同一根因的风险，而非另计一个 bug。

应在事件开始冻结 files、targetKbId、items 和 batchId，全程使用快照；对目标被删除或新批次进入定义明确规则。测试用延迟解析模拟用户切库，再核对所有新论文的最终 knowledgeBaseId。

<a id="F10"></a>

### F10　跨页正文的句子引用伪装成第一页精确定位 P2 · 动态复现

> 当前状态：本轮交付已修复；以下保留原审查基线的现象、证据和建议。

src/utils/doclingAbstract.ts:124、137、148、154；src/utils/doclingDocument.ts:118、153

一条 Docling text 可以覆盖多页，但归一化没有保留句子字符区间到页面的映射。materializeAbstract 生成引用时直接 pages.slice(0,1)，再只取该页 bbox。

**复现：**text 为 “Page zero sentence. Page one finding.”，pages=[0,1]。引用第二句 text-1-s2 得到 `paper-source:paper:0:…:Page%20one%20finding.`，来源也只有 startPage=0、endPage=0；页码为 0-based，实际跳向第一页。

应保留 Docling provenance 的 charspan，将句子映射到实际页面／区域；定位不可靠时展示真实跨页范围并降级精度，不应构造错误的单页精准来源。验收需覆盖跨页文本、跨页表格、重复句和 bbox 缺失。

<a id="F11"></a>

### F11　PDF.js 升级后的资源销毁接口不一致 P2 · API 核验与探针

> 当前状态：本轮交付已修复；以下保留原审查基线的现象、证据和建议。

src/utils/doclingPdf.ts:15、48、56；src/utils/pdfDocument.ts:141、149；src/tests/doclingPdf.test.ts:14

Docling 补截图 load 返回真实 PDFDocumentProxy，finally 却调用 pdf.destroy() 并吞异常。当前 pdfjs 6 的该对象没有 destroy；正确入口为 loadingTask.destroy()，项目 pdfDocument adapter 已使用这个入口。测试替身模拟的是 {destroy}，恰好掩盖真实接口差异。

使用与真实对象一致的 `{loadingTask:{destroy:spy}}` 完成补图后，spy 调用数为 0。可确认销毁未执行；具体内存增长和 worker 保留量没有做压力测量。

应复用统一 PDF adapter，避免 any 绕开接口约束；finally 要实际销毁 loadingTask。补测成功、裁剪失败和中途取消均清理资源，并在真实 Electron 中做多篇补图的资源稳定性检查。

<a id="F12"></a>

### F12　评测对象已经落后于正式产品 P2 · 工程覆盖缺口

> 当前状态：本轮交付已修复；以下保留原审查基线的现象、证据和建议。

src/stores/chat.ts:1359、1515；bench/src/runner/qa.ts:151、184、275；bench/src/runner/summary.ts:2、6、26、45；src/tests/ek5.test.ts:16

正式 QA 固定 retrievalMode:'ek5'，正式摘要使用 Docling 和当前 LLM；bench QA 构建 PageIndex／semantic／passage，未传 E-k5；bench summary 仍调用 HuggingFace T5。bench/src 中没有 E-k5 引用。部分注释仍声称“生产实现”“应用跑同一份代码”。

**含义：**保留历史实验是合理的，E-k5 方案也有意冻结历史结果；问题是缺少当前产品等价的可执行评测入口。不能用旧 benchmark 的分数、速度或大量旧路径测试证明当前产品质量。

现有 E-k5 冻结测试用 JSON／确定性假向量核对正文和排序，有回归价值，但不覆盖真实 PDF 提取、真实模型、缓存、来源定位或整条摘要质量。

**建议：**明确区分 legacy benchmark 和 product benchmark，新增 E-k5／Docling 版本化入口。至少记录真实 PDF 指纹、算法与模型 revision、叶子组覆盖率、来源页命中、字符／token 预算、首答与多轮质量、冷／热启动成本。不要回写历史分数来“对齐”新产品。

<a id="F13"></a>

### F13　Windows 发布文件名前缀为空 P3 · 静态确认

> 当前状态：本轮交付已修复；以下保留原审查基线的现象、证据和建议。

.github/workflows/release.yml:72、85、87

脚本定义 APP 大写变量，Windows 分支却使用 app 小写。正常未定义 app 的环境下，产物会变为 `-<tag>-win32-x64.exe`，不符合旁边约定的 name-version-platform 格式。这通常不会阻止生成 exe，但交付命名错误。

统一使用 APP，并给重命名逻辑增加轻量脚本验证；Release 的构建命令还绕过 npm run build 中的 icons:check，建议统一构建入口。没有运行真实 GitHub Release，也不推测当前远端作业结果。

<a id="risks"></a>

## 四　设计风险与实现边界

以下问题有明确代码依据，但其中部分符合当前冻结设计。应当作为设计决策、观测或下一版算法评估处理，不能全部包装成“代码写错”。

### R01　叶子章节策略必然排除一部分正文

src/utils/ek5/headingGroups.ts:92、94、111

父章节到首个子标题之间的 lead-in，以及标题前摘要等，可能不属于任何叶组；未知边界还会排除整组。合成两页文档中父节关键事实被排除，excludedSourceCharacters=42，即使所有组都选入 context 也找不回。它符合 leaf-only 合同，是信息覆盖取舍，不是违反冻结算法。建议将排除比例与不可检索区域做可见诊断并纳入真实论文评测；要扩大覆盖应升算法版本，而不是偷偷改变历史口径。

### R02　E-k5 的 ContextPiece 页映射契约错误，当前产品尚未消费

src/utils/ek5/index.ts:74

当前用一个 {page:startPage,text:整组全文} 表示跨页章节，后页正文也归到首页。正式产品的来源区间使用另一组字段，所以不能把它报成当前所有章节跳页错误；但将该输出直接接入共用物化器／bench，会产生假页序和误导的 MRR。应从 SourceRange 逐页产生正文 piece，标题标签与正文分开。接入 F12 的新评测前先修该契约。

### R03　缓存身份没有完整覆盖算法与任务配置

src/utils/ek5/index.ts:38；src/utils/ek5/tocTree.ts:42；src/utils/ek5/store.ts:20；src/stores/chat.ts:1333、1358

E-k5 验证产品版本、pages 哈希和 embedderId，但 TOC_TREE_CONFIG_SHA256 没进入落盘身份；标题算法修改后若忘记手动升级产品版本，会复用旧记录。正式 QA 又在不同 await 阶段读取 chatProfile.value，未冻结整轮 profile，可能出现检索等待期间切换模型／提示词。前者是版本纪律风险，后者是任务快照设计债；本次没有证明当前已产生哪一份错误缓存或跨模型输出。建议引入显式 PipelineIdentity／RunConfig，并为缓存失效与运行快照分别测试。

### R04　删除和清空也跨越 SQL 与文件系统

electron/db/index.ts:114、175、397

批量删除先逐个 unlink PDF 再删数据库；第二个文件失败时，第一个文件已丢失，数据库却可能完整保留。这与 F01 属于同一个架构根因，不重复计数。建议统一受管文件服务，先移到可恢复隔离区，再提交数据库，最终清理；启动时处理未完成批次。

### R05　文件边界与 IPC 校验没有统一执行

electron/paperProtocol.ts:29；electron/db/index.ts:182、378；electron/ipc.ts:27、67、87、126；electron/webPreview.ts:410

协议和删除使用 storedPaperFilePath 校验受管路径；旧 readFile 与 exportAll 直接信任数据库 file_path。若已有遗留或外部改写行指向外部文件，协议可能拒绝，读取／导出／Docling 却仍读取。新备份导入已忽略外部 file_path，不能据此宣称“恶意备份即可任意文件读取”。preview IPC 验发送者，其余 handlers 多数忽略 event；外部预览无 preload，未发现直接取得 window.db 的通路。建议所有文件入口复用守卫，IPC 统一 sender policy，并对运行时载荷做 schema 校验。共享 TypeScript 类型不能替代这两个运行时边界。

### R06　本地优先与部署环境需要明确区分

electron/doclingClient.ts:8；electron/doclingTunnel.ts:4、5、23；README.md:57

Docling 默认 loopback 端点会启动固定个人账号／主机的 SSH 转发。README 已明确说明远端解析和免交互 SSH 前提，不是秘密上传；但通用发行物依赖个人环境，其他用户难以复用默认体验。应将“本地 HTTP”“用户配置的 SSH”“其他远程 Docling”显式建为不同连接模式。API Key 明文 SQLite 也是已披露取舍，可按产品威胁模型采用 safeStorage；本次没有将其上升为已利用漏洞。

### R07　模型与上下文策略缺少真实语料验证

src/utils/transformersEmbedder.ts:2；src/utils/answerMessages.ts:15、29；src/stores/chat.ts:796

固定英文 bge-small 模型与标题路径向量，对于中文问题问英文论文、正文特有事实和泛化标题是否足够，需要真实语料测量，不能仅凭模型名字断言失败。120000 字符参考上限也不包含最近 19 条历史、系统提示和输出预算；可能超过某个 provider 的上下文窗口。应冻结产品质量集和长上下文边界，分别观测召回、拒答与超限失败体验，不要直接用字数推导所有模型都安全。

### R08　摘要“引用合法”与“论断有证据”尚未形成同一质量契约

src/utils/doclingAbstract.ts:98、121；src/utils/doclingDocument.ts:27、28；electron/db/paperAbstract.ts:24、34

materializeAbstract 校验引用 ID／链接及素材存在，不证明生成论断被原句蕴含，也不保证 map/reduce 后证据完整。图片启发式要求英语 Figure／Fig、图注在下方及固定空间范围，会保守排除中文／上置图注等；应评估图片筛选 precision／recall，避免笼统承诺所有原图都可展示。专用摘要版本门禁又有回退无版本历史聊天摘要的兼容例外：这是产品兼容选择，需要明确标记旧内容可信度，不应误称所有展示结果都经过当前证据规则。

### R09　同步全量操作与渲染主线程负载缺少规模预算

electron/db/index.ts:374；electron/ipc.ts:110；src/utils/transformersEmbedder.ts:115、123；vite.config.ts:20

全量备份同步读取 PDF、base64 编码、构造整个对象、JSON.stringify 后同步写盘，发生在主进程。大库会带来事件循环阻塞和峰值内存增长的结构性风险；本次没有做大库压力测量，不能给出实际卡顿秒数。向量推理采用 WASM 单线程，但没有在这里设置独立推理 worker，是否影响交互也需真实桌面 profiling。建议先测 100／1000 篇、含网页原貌和截图资产的备份，再决定 worker、流式归档、分批读取及取消／进度机制。Vite 构建观察到约 2.22MB 的主 JS chunk 和约 902KB 的 transformers chunk；这是包体证据，不等于启动耗时结论。

### R10　架构文档和职责边界滞后

src/stores/CLAUDE.md；src/utils/CLAUDE.md；electron/CLAUDE.md；bench/src/runner/qa.ts:4；bench/src/runner/summary.ts:2

部分文档仍描述 7 张表、PageIndex 三次模型调用、语义树默认／可开、HF 摘要，实际 schema 已有 16 张表，正式产品为 E-k5＋Docling。保留旧算法本身合理，但缺少“当前规范／兼容实现／历史实验”的显式边界，维护者容易沿旧说明修错路径。

chat.ts 约 1553 行不是单独的缺陷，真正问题是其内部各功能没有共用运行、配置快照、取消、错误和持久化契约；这已对应 F04／F06／F08 等实际偏差。建议抽出 ProviderClient、ConversationRunService、PaperRetrievalService、PaperAbstractService，store 保留响应式状态和用例入口；历史算法放到明确的 legacy／experimental 边界。先补行为测试再移动代码，避免仅把大文件拆成多个同样耦合的小文件。

<a id="tests"></a>

## 五　验证结果与测试盲区

| 验证 | 本次结果及能证明的范围 |
| --- | --- |
| `npm run typecheck` | 退出码 0。当前 Vue／TypeScript 签名通过，不证明运行时文件原子性或真实第三方对象行为。 |
| `npm test` | 133 个测试文件全部通过，共 1639 tests；包含 src 的 80 文件与 bench 的 53 文件。之后品牌／安装脚本 19 tests 通过。 |
| `npx vite build --outDir /tmp/papermind-audit-build` | 退出码 0，renderer、main 和 preload 打包成功。存在大 chunk 告警。未执行 electron-builder 安装包发布／跨平台运行。 |
| 外置前端定向 Vitest | 1 文件、3 tests 通过；主 agent 复跑。断言的是 A 上下文传入 B、摘要无法停止且允许交错、Ollama 遗漏温度。 |
| 数据库隔离探针 | subagent 内存打包实际 DB 模块，临时 userData 和 fs 故障注入；复现 F01／F02／F03，未接触真实用户库。 |
| 流协议探针 | 主 agent 转译当前真实解析函数，合成 ReadableStream 输入；复现提前 EOF／error 误判成功及无换行末条丢失。 |
| Docling／E-k5 探针 | 合成文档复现跨页引用、真实形态 PDF 清理遗漏、父节正文排除和 ContextPiece 页归属。未调用远程模型／解析服务。 |

**测试全绿与问题同时存在的原因：**现有测试覆盖许多局部行为与历史路径，但部分替身和成功输入没有表达跨模块不变量。F11 是典型例子：错误的 {destroy} 假对象让测试稳定通过，而真实 PDF.js 对象没有该方法。数据库已有真实 SQLite 场景测试，因此也不能说“所有测试都只 mock 数据库”；缺的是提交后的文件故障与启动后的端到端验证。

1. **数据不变量：**导入／删除任何一步失败后，数据库、PDF、索引和 UI 仍指向同一代数据；缺失原文不能替换成同 ID 的另一份字节。
2. **会话不变量：**问题、上下文、profile、assistant 占位和 runId 从开始到结束属于同一会话；任何任务都可停止且有明确终态。
3. **协议不变量：**terminal／error／EOF 三者不混淆；最后一条无需强制换行；错误后保存部分正文但不能标成功。
4. **证据不变量：**句子／正文片段的文本、页号、bbox、PDF 指纹同源；跨页位置不伪造单页精度。
5. **对象接口不变量：**mock 和 adapter 满足真实依赖的窄接口；至少有实际 Electron＋PDF.js 的资源清理冒烟。
6. **产品等价性：**评测入口与产品使用同一版本化管线，模型、上下文预算、重写和缓存模式显式记录；真实多栏 PDF、父节 lead-in、无目录、重复标题、长文和中英文问题进入质量集。
7. **规模与系统边界：**大库备份／恢复、MHTML 断网重现、真实 session／导航权限、SSH 失效和退出中断需要独立系统测试。

Node 26 环境运行测试时出现 localStorage experimental warning，未造成失败。上面的构建通过不代表安装包已验收，合成输入复现不代表问题在真实语料中的发生率；报告没有将未测性能、模型质量或安全风险写成已测结论。

<a id="roadmap"></a>

## 六　建议的整改顺序与验收标准

| 阶段 | 独立交付目标 | 验收要点 |
| --- | --- | --- |
| 第一阶段<br>正确性止血 | F01／F02／F03 数据恢复；F04 流终止；F05 会话 composer；F06 摘要锁与占位 | 故障注入不丢原状态；不同会话不串上下文；全部运行有终态；异常流保留 partial 并报错。每个独立目标单独验收，不混成一次“大重构”。 |
| 第二阶段<br>来源与交互一致 | F07 高亮唯一源；F08 provider 参数；F09 批次快照；F10／F11 证据与资源 | 笔记删除立刻反映在 PDF；发送参数匹配 UI；切库不改变批次目标；跨页引文定位正确；真实 PDF 清理执行。 |
| 第三阶段<br>质量闭环 | F12 当前产品评测；先修 R02 页片段契约；标注历史实验、同步文档；顺带独立修 F13 发布命名 | 旧实验结果仍可复现；新增结果明确 E-k5／Docling 身份；真实 PDF 的检索与引文质量可比较，避免把旧 benchmark 当产品指标。 |
| 第四阶段<br>边界收敛 | 统一 RunService／ProviderClient／文件服务；配置快照与算法身份；性能和部署模式 | 行为测试先固定，迁移后结果一致；共享取消、错误、配置和缓存身份；用测量决定 worker／流式归档，避免为拆层而改层。 |

**建议的目标边界：**UI 只维护视图与按业务 ID 归属的草稿；Pinia 暴露用例与状态；ConversationRunService 负责全部聊天命令的锁、assistant 占位、取消、进度和终态；ProviderClient 负责协议及参数；Retrieval／Abstract 服务返回带版本与 provenance 的结果；主进程 ManagedPaperFiles＋repositories 共同实现可恢复的数据变更。产品评测调用同一服务边界，legacy 实验明确隔离。

不建议在没有上述验收保护前更换检索算法、数据库或状态管理框架。当前最有价值的工作是修复已经证明的边界错误，并使后续每次功能迭代都能验证“用户意图、存储结果和实际执行的是同一件事”。

<a id="appendix"></a>

## 七　关键代码索引

所有定位均相对于 `/home/xmdjy/cs/PaperMind` 的本次基线。后续代码变更后行号可能移动。

| 主题 | 入口 |
| --- | --- |
| 启动与 IPC | electron/main.ts；electron/preload.ts；electron/ipc.ts；src/types/ipcContract.ts |
| 数据库与备份 | electron/db/schema.ts；electron/db/index.ts；electron/db/backupValidation.ts；src/views/SettingsView.vue |
| 会话与任务 | src/stores/chat.ts；src/components/ChatPanel.vue；src/types/chatRun.ts；electron/db/chatRun.ts |
| 论文与高亮 | src/stores/paper.ts；src/views/LibraryView.vue；src/views/ReaderView.vue；src/components/PdfViewer.vue；src/components/NotesPanel.vue |
| 当前检索 | src/utils/ek5/store.ts；tocTree.ts；headingGroups.ts；index.ts；src/utils/ragPipeline.ts；answerMessages.ts |
| 当前摘要 | electron/docling.ts；doclingClient.ts；doclingTunnel.ts；src/utils/doclingDocument.ts；doclingPdf.ts；doclingAbstract.ts；electron/db/paperAbstract.ts |
| 网页归档与问答 | electron/webPreview.ts；electron/db/webQa.ts；src/views/WebPreviewView.vue；src/composables/useWebQa.ts；useWebPageHistory.ts |
| 评测与交付 | bench/src/runner/qa.ts；summary.ts；bench/src/streaming；vite.config.ts；.github/workflows/ci.yml；release.yml |

审查交付：只读架构与实现报告。报告未包含用户凭据、真实用户 PDF 或数据库。临时探针只使用构造输入；未执行修复、提交、推送或发布。
