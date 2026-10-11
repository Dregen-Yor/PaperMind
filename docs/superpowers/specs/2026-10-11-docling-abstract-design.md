# Docling 图文论文解读设计

日期：2026-10-11。分支：`feat/docling`。

## 已确认的目标与范围

将 `/abstract` 升级为详细中文图文论文解读。用户已确认：独立 Docling HTTP 服务；使用当前对话 LLM 配置；第一版只支持 PDF；图片理解依据图注与相关正文，不向 LLM 发送图片；输出研究问题、贡献、方法、实验结果与局限。2026-10-11 用户批准整体流程和展示、异常规则，并授权写设计、施工方案后直接实现；不再增加一次文档审批等待。

图片选择与讲解需要对应正文，不能将全部图片机械附在末尾。保留原图号和表号。原图可以放大；表格用结构化数据分析、用原表截图展示；公式优先 LaTeX/KaTeX，识别或渲染失败时使用原文区域截图。正文与素材的页码引用均可跳回 PDF。多篇论文按所选论文逐篇解读，不混合不同论文的素材。

## 选择的接入方式

采用 Docling JSON + 应用管理的素材清单，而不是让 LLM 改写包含图片路径的 Markdown。主进程负责服务请求和缓存；渲染进程沿用 PDF.js、Markdown、KaTeX 和现有 LLM 请求实现。无需打包 Python、Docling 模型或额外后端。

服务协议以官方 `docling-serve` REST API 为基准：`POST /v1/convert/file`，multipart PDF，请求 JSON 输出、embedded 图片、准确表格结构和可配置的 OCR/公式增强。服务地址为根地址，可含反向代理路径前缀；可选 `X-Api-Key`。连接测试读取服务 OpenAPI，确认转换接口存在。用户自行部署模型与服务，服务端模型目录不放进桌面应用配置。

参考：
- https://github.com/docling-project/docling
- https://docling-project.github.io/docling/usage/api_server/rest_api/
- https://docling-project.github.io/docling/usage/enrichments/

## 数据流

1. `/abstract` 检查所选论文、Docling 配置和对话模型。
2. 主进程读取 PDF，计算真实文件 SHA-256，结合服务地址、解析选项及应用解析 schema 形成缓存指纹。认证密钥不进入指纹。
3. 已有有效缓存直接返回。否则调用 Docling；将 body 的阅读顺序、文本、标题、图片、表格与公式归一为应用数据。
4. 素材关联 Docling 的 self_ref、图注、页码与 bbox；Docling 的 1-based 页码在边界归一成应用 0-based 页码。bbox 同时支持 TOPLEFT 与 BOTTOMLEFT。
5. 已返回的 raster 图片直接保留。缺少图片像素但具有有效 bbox 时，使用本地 PDF.js 高分辨率裁剪，包括矢量示意图、表格和公式。跨页素材保留多个区域。无 bbox 不臆造裁剪框；显示明确警告。
6. 原子保存解析清单与不可变素材。重复生成复用解析，LLM 失败不丢解析缓存。
7. 将有编号、页码的原文证据分批交给当前对话模型提炼；超长论文采用有界输入的递归汇总，不直接截掉论文后半部分。
8. 最后生成详细解读，使用 `{{asset:ID}}` 与 `{{cite:ID}}` 引用应用清单。应用只物化存在的编号，给原图/表格附来源；非法引用提示警告，不生成假来源。
9. 对话持久化 Markdown 与稳定素材 ID。渲染组件经 IPC 加载本地图片，正文不存 base64，后续聊天历史不携带图片字节。

## 共享数据与持久化

`DoclingSettings`：`baseUrl` 默认空；`apiKey` 默认空；`timeoutSeconds` 默认 600（30–1800）；`ocr` 默认 true；`formula` 默认 true。保存在 `settings.docling_config`。允许先保存空地址，触发功能或测试连接时才要求 HTTP/HTTPS 地址。导出备份默认清空 API key。

`ParsedDocument`：schema version、按阅读顺序的 items 和 warnings。每个 item 有稳定 ID、kind、原始 text、caption、pages、归一化 regions 和 images。表格单元格结构转换成带位置的文本，不能把模型重写的数字当作原表。公式 text 保留以供 KaTeX 渲染，始终尽量保留区域截图作为回退。未知页码用空 pages，不创建可跳转页码。

新增 `document_parses`（每篇当前解析、source/config hash、document JSON、created_at）与 `document_assets`（不可变图片 ID、paper_id、MIME、binary BLOB）。图片用论文 ID + 内容 SHA-256 寻址；新的解析不会覆盖旧消息引用的图片。纸张删除、知识库级联删除及清空数据通过外键清理对应记录。备份增加解析与素材字段，图片转 base64；导入恢复稳定 ID，旧备份没有新字段也可读。拒绝不支持的图片类型和过大图片。

接口通过 `window.db.docling` 暴露：`convert(paperId)`、`save(paperId, record)`、`readAsset(id)`、`testConnection(settings)`。数据库、schema、preload 和 renderer 类型同步。save 写入前复核文件及解析配置，避免旧异步结果写入新配置。

## 生成与引用

使用当前 chat profile 的 provider、model、baseUrl、apiKey、temperature、输出上限与系统提示词，在开始时快照，避免中途换配置。对文档内容明确视为数据，要求中文、忠于证据、解释图表时依据图注/正文、明确未报告的信息。按需选图，不固定数量，不推断未给出的图内细节。

生成只引用素材/证据 ID，不允许自造 URL、本地路径或未经校验页码。应用将合法引用变为受控素材链接和 PDF 来源链接，并生成现有 SourceRef。原表和图片的标题与页码来自解析结果。公式引用尝试 KaTeX；无效公式显示原文截图或识别警告。输出被模型上限截断时保留截断状态；续写复用 Docling 证据，不能走普通问答 RAG。重试原地更新失败轮。

## 界面与状态

设置页以 Docling 服务设置替代旧 Hugging Face 摘要设置。提供根地址、可选 key、超时、OCR/公式选项、保存与连接测试。说明 PDF 会发送到所配置服务，摘要使用当前对话模型。

`/abstract` 的准备状态按对话显示：解析文档、整理素材、章节提炼进度、生成解读。正常问答继续使用已有流程。解读仍显示在当前对话，无新增独立编辑器或报告路由。图片懒加载，加载失败显示占位反馈；点击或键盘可放大；来源点击和键盘激活都 emit 原有 open-source。

## 异常与兼容

地址未填：明确引导设置，不静默使用旧 T5。认证、HTTP 错误、超时、错误 JSON、转换 failure/skipped、缺少正文：中文错误卡，可重试。partial_success 可用时保存警告并在解读中显示；没有可靠来源时不创建页码。裁剪失败保留可分析的图注/表格文本并明确提示，不能伪装成已显示原图。

旧聊天 Markdown 和旧 SourceRef 保持可读。旧摘要工具仍供已有离线 benchmark 使用；本功能不修改 benchmark 评测契约，也不扩展普通问答的检索算法。备份默认剔除新凭据。现有用户未提交的 `prompt.md` 不纳入提交。

## 验收

- 标准 Docling JSON、body 阅读顺序、图注关联、表格/公式、嵌入图片与 bbox 回退都有 focused tests。
- 0/1-based 页码、上下坐标原点、跨页素材、无 provenance、坏引用不得造来源。
- HTTP multipart、认证、非兼容服务、错误与超时、缓存指纹、旧结果防写入可用 fake service/依赖注入验证。
- SQLite 素材稳定 ID、备份脱敏/恢复、删除级联与旧备份兼容验证。
- `/abstract` 使用当前模型、多论文、失败重试、缓存复用及续写测试。
- 图片恢复、放大与页码跳转用 Vue 组件测试；UI 实际效果可用合成素材演示，不使用用户论文。
- 必须通过 `npm test`、`npm run typecheck`，并完成 Vite/Electron bundle 检查。
- 用户尚未提供服务地址，因此本轮不声称真实 Docling 模型已联调；提供部署与人工联调说明。
