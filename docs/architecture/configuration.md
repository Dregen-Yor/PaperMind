# Configuration Boundaries

本文区分项目维护配置、用户凭据和有意保留的代码常量。配置是否可由普通用户修改，以这里列出的所有权边界和运行时代码为准。

## Official Docling Configuration

以下字段由项目维护，唯一来源是 [`config/docling-service.json`](../../config/docling-service.json)。应用启动时严格校验并深度冻结配置；设置页只读展示服务地址，不提供覆盖入口。

| 字段 | 当前值 | 用途 |
|---|---|---|
| `schemaVersion` | `1` | 配置结构版本 |
| `baseUrl` | `https://docling.example.com` | 官方 HTTPS 服务根地址；当前是部署前占位地址，预期暂时不可用 |
| `timeoutSeconds` | `60` | 连接测试和 PDF 转换的统一时限 |
| `conversion.fromFormat` / `toFormat` | `pdf` / `json` | 输入输出格式 |
| `targetType` / `imageExportMode` | `inbody` / `embedded` | 正文材料与图片返回方式 |
| `includeImages` / `imageScale` | `true` / `2` | 原始图片提取 |
| `ocr` | `rapidocr`，启用 | 官方 OCR 能力 |
| `formula` | `codeformulav2`，启用 | 官方公式识别能力 |
| `table` | `accurate` / `tableformer_v1_accurate`，启用 | 官方表格结构识别能力 |
| `layoutPreset` | `layout_heron_default` | 官方布局模型预设 |

普通用户不能修改地址、超时、OCR、公式、表格、布局或图片选项。PDF 解析失败时显式报错，不回退到本地解析、端口探测或 SSH 转发。网页 HTML/MHTML 摘要材料仍由 `electron/htmlSummary.ts` 在本地解析，不经过 Docling。

## User-Maintained Secrets

| 设置键 | 用户可写字段 | 存储与备份行为 |
|---|---|---|
| `docling_config` | `apiKey` | 保存于 SQLite `settings`；默认导出置空；旧 URL/超时/OCR/公式字段导入时丢弃 |
| `llm_profiles` | provider API keys | 保存于 SQLite；默认导出置空 |
| `huggingface_token` | token | 兼容设置；默认导出置空 |

Docling API Key 仅通过 typed IPC 进入主进程。`docling:testConnection` 严格拒绝 `baseUrl`、`timeoutSeconds` 等额外字段；PDF 缓存身份不包含 API Key。

## Intentional Constants

| 类别 | 常量/协议 | 所在位置 |
|---|---|---|
| Docling 缓存 | pipeline version + 官方配置 SHA-256 | `electron/docling.ts` |
| Docling 安全 | 64 MiB PDF、最多 2 个并发请求、64 MiB JSON、禁止重定向 | `electron/doclingClient.ts` |
| 解析文档 | `ParsedDocument.version = 1`、12 MiB 单图上限 | `src/utils/doclingDocument.ts` |
| 统一摘要 | `parsed-materials-v1` 与 source/parser identity | `electron/summaryParsing.ts` |
| E-k5 | `ek5-product-v1`、默认 120000 字符上下文 | `src/utils/ek5/`、`src/stores/chat.ts` |
| benchmark | `--docling-official` 使用生产官方配置；`--docling-json` 可提供绑定原 PDF hash 的离线材料 | `bench/src/productCli.ts` |
| UI | 保存/恢复提示、预览尺寸和交互延时 | 对应 view/component；这些是产品行为常量，不是用户部署配置 |

新增可配置项前，应先确定所有者、信任边界、迁移与备份语义，并同步更新运行时校验、设置 UI 和本页。
