# 官方 Docling 服务配置设计

日期：2026-11-16

状态：已批准

基线：`fec4912`（PR #14 产品基线加架构文档修订）

## 1. 背景

当前 PaperMind 的 Docling 接入同时包含用户设置和部署细节：

- 默认地址写死为 `http://127.0.0.1:5001`；
- 使用默认地址时，Electron 主进程自动创建到私人主机的 SSH 隧道；
- SSH 用户、主机、本地端口、远端端口和连接参数写死在
  `electron/doclingTunnel.ts`；
- 设置页允许普通用户修改服务地址、超时、OCR 和公式开关；
- 表格、布局、OCR engine、公式 preset 和图片参数散落在
  `electron/doclingClient.ts`；
- 设置页帮助文字与实际 SSH 主机已经不一致。

这套结构带有私人部署假设，不适合通用发行版，也无法保证 PDF 解析、OCR、公式和表格处理始终使用项目维护者提供的官方服务契约。

## 2. 目标

本次改动把所有 Docling PDF 解析统一到一条官方 HTTPS 服务链路：

- 官方服务地址暂定为 `https://docling.example.com`；
- 官方请求超时固定为 60 秒；
- OCR、公式、表格、布局和图片参数由项目级只读配置统一定义；
- 普通用户不能修改服务地址、超时或解析能力；
- 普通用户只能配置官方服务 API Key；
- 删除 SSH 隧道、本地 Docling 默认值和所有备用连接路径；
- 服务不可用时明确失败，不静默回退；
- 保持现有已保存 API Key 和备份脱敏行为兼容。

`https://docling.example.com` 当前不可用是已知部署状态。本次交付只建立正确的产品架构和请求契约，不宣称真实官方服务已经上线。

## 3. 非目标

- 不内置、下载或启动本地 Docling 服务。
- 不允许用户填写自定义 Docling URL。
- 不支持 SSH、端口转发、代理服务发现或多服务器切换。
- 不把 API Key 写入项目配置、环境变量或构建产物。
- 不改变网页 HTML/MHTML 的本地解析路径；该路径不经过 Docling，也不包含 PDF OCR。
- 不在本次改动中配置化 LLM provider、E-k5 算法、文件大小安全上限或 benchmark 冻结参数。

## 4. 配置模型

### 4.1 项目级只读配置

新增 `config/docling-service.json`，作为官方服务契约的唯一可编辑来源：

```json
{
  "schemaVersion": 1,
  "baseUrl": "https://docling.example.com",
  "timeoutSeconds": 60,
  "conversion": {
    "fromFormat": "pdf",
    "toFormat": "json",
    "targetType": "inbody",
    "imageExportMode": "embedded",
    "includeImages": true,
    "imageScale": 2,
    "ocr": {
      "enabled": true,
      "engine": "rapidocr",
      "preset": "rapidocr"
    },
    "formula": {
      "enabled": true,
      "preset": "codeformulav2"
    },
    "table": {
      "enabled": true,
      "mode": "accurate",
      "preset": "tableformer_v1_accurate"
    },
    "layoutPreset": "layout_heron_default"
  }
}
```

该文件随源码和构建产物一起版本化。普通用户没有 UI 或 IPC 能力修改它；未来官方地址或服务参数变化必须通过项目发布完成。

共享纯模块负责把 JSON 校验为不可变的 `OfficialDoclingConfig`。校验规则包括：

- `schemaVersion` 必须为受支持版本；
- `baseUrl` 必须是无凭据、无 query、无 fragment 的 HTTPS 根地址；
- 字面 IP 不得属于 loopback、私网、链路本地或保留地址；
- 超时必须是有界正整数，本版本固定为 60 秒；
- conversion 字段必须完整，未知字段拒绝加载；
- 配置中出现 `apiKey`、`token`、`secret` 等敏感字段时拒绝加载。

域名由项目维护者控制，不再构成用户输入的 SSRF 面。请求继续禁用重定向；官方配置错误应在开发/测试阶段显式失败，而不是回退到本地或历史地址。

### 4.2 用户凭据

用户配置缩减为：

```ts
interface DoclingCredentials {
  apiKey: string
}
```

API Key 继续保存在 SQLite `settings` 中。沿用 `docling_config` key 可以减少备份和迁移面，但其新持久化形状只包含 `apiKey`。

旧值迁移规则：

- 旧对象中的 `apiKey` 被保留并 trim；
- `baseUrl`、`timeoutSeconds`、`ocr`、`formula` 等旧字段被忽略；
- 下次保存时只写回 `{ apiKey }`；
- 旧配置是否指向 localhost、私人 IP 或历史服务器不影响新请求；
- 默认备份继续把 `docling_config.apiKey` 替换为空字符串；
- 包含 API Key 的显式明文备份仍遵循现有用户确认流程。

## 5. 模块边界

### `src/types` / `src/utils`

- 定义 `OfficialDoclingConfig`、`DoclingCredentials` 和严格校验器。
- 导出只读 `OFFICIAL_DOCLING_CONFIG`，由 `config/docling-service.json` 生成。
- `DoclingSettings` 不再混合官方部署参数与用户凭据；现有调用方按职责改用上述两个类型。
- Docling 文档数据结构、图片格式和解析结果校验保持不变。

### Electron 主进程

- `electron/doclingClient.ts` 从 `OFFICIAL_DOCLING_CONFIG` 生成 multipart 参数。
- `convertPdf`、`convertPdfForSummary` 和连接测试只接收用户凭据，不接收 URL、超时或解析选项。
- 所有网络请求固定发送到官方 `baseUrl`，使用 60 秒 abort timer，并设置 `redirect: 'error'`。
- `electron/doclingTunnel.ts` 整个删除。
- `electron/main.ts` 删除 tunnel stop hook。
- `electron/docling.ts`、`electron/summaryParsing.ts` 和 `electron/ipc.ts` 只读取用户 API Key，再由 client 合并官方只读配置。
- cache/config hash 必须包含完整官方配置及其 schema version。官方配置变化会使旧 PDF 解析缓存失效并重新解析。

### IPC 和 preload

- `docling:testConnection` 参数收窄为 `DoclingCredentials`；它允许测试设置页中尚未保存的 API Key。
- renderer 无法通过 IPC 传入 URL、超时、OCR、公式、表格或 layout 参数。
- 现有 trusted-frame 检查继续适用；主进程仍对凭据形状做运行时校验。

### Renderer store

- `chat` store 只维护 `doclingCredentials` 和凭据校验错误。
- 初始化时从旧 `docling_config` 提取 API Key。
- 保存方法只接受/落盘 `{ apiKey }`。
- 官方服务地址可作为只读产品信息导入显示，但不成为响应式用户设置。

### Settings 页面

Docling 卡片改为：

- 标题明确为“官方 Docling 文档解析服务”；
- 只读显示 `https://docling.example.com`；
- 说明 PDF、OCR、公式和表格会发送到官方服务；
- 只保留 API Key 密码输入框；
- 保留“保存 API Key”和“测试官方服务”操作；
- 删除地址、超时、OCR、公式和表格控件；
- 服务未部署或不可达时展示真实连接错误，不显示可用成功状态。

普通用户不需要知道 engine/preset 细节；这些内容记录在架构文档和官方配置中。

## 6. 请求数据流

```text
用户保存 API Key
  → settings.docling_config = { apiKey }

论文解析 / 论文摘要
  → main process 读取 { apiKey }
  → 加载并验证 OFFICIAL_DOCLING_CONFIG
  → 根据官方 conversion 配置构造 multipart/form-data
  → POST https://docling.example.com/v1/convert/file
  → 60 秒超时 / 禁止重定向 / 有界响应读取
  → 校验 Docling status 和 JSON 文档
  → normalizeDoclingDocument
  → repository/cache 或 unified summary pipeline
```

不存在 tunnel、本机端口探测、动态 base URL 或 fallback 分支。

连接测试固定请求：

```text
GET https://docling.example.com/openapi.json
```

并验证 schema 中存在 `/v1/convert/file` POST 接口。连接测试同样使用官方 60 秒上限，避免形成第二套超时配置。

## 7. 公式、表格与 OCR 行为

以下字段全部由官方配置决定，用户无法覆盖：

- `do_ocr=true`；
- `ocr_engine=rapidocr`；
- `ocr_preset=rapidocr`；
- `do_formula_enrichment=true`；
- `code_formula_preset=codeformulav2`；
- `do_table_structure=true`；
- `table_mode=accurate`；
- `table_structure_preset=tableformer_v1_accurate`；
- `layout_preset=layout_heron_default`；
- `include_images=true`；
- `images_scale=2`。

普通转换与 summary 转换使用同一能力集合，避免当前只有 summary 请求追加部分 preset 的分叉。两条路径仍可在“是否接受 partial success”等业务语义上不同，但不能改变官方解析参数。

## 8. 错误处理

- 配置 schema 错误：开发和构建验证失败，应用不得带损坏配置发布。
- API Key 缺失：仍允许发起连接测试或请求，由官方服务决定是否需要认证；401/403 明确提示检查 API Key。
- DNS、TLS 或连接失败：提示官方服务暂不可用，不建议填写其他地址。
- 60 秒超时：提示官方解析超时，不向用户暴露可修改超时入口。
- 非 2xx：保留 HTTP status，不输出响应中的潜在敏感内容。
- 非 JSON、超大响应或不完整 schema：按现有有界解析策略失败。
- `partial_success`：普通转换可携带 warning；统一摘要仍拒绝不完整材料。
- 所有失败都禁止回退到旧缓存以外的其他服务器或本地进程。

## 9. 安全与隐私

- API Key 不进入官方配置、日志、错误消息或默认备份。
- 官方 endpoint 使用 HTTPS，禁止 URL 凭据和重定向。
- PDF 会上传到官方服务；设置页必须明确告知用户这一数据边界。
- 主进程继续限制 PDF 大小、响应大小、图片大小和并发数；这些是安全上限，不属于用户配置。
- renderer 不能控制 endpoint 或 multipart 参数，降低 SSRF 和服务端资源滥用面。
- 官方 URL 当前为占位域名；上线前必须替换并进行真实 TLS、认证、大小限制和超时验证。

## 10. 测试策略

### 配置与迁移

- 官方 JSON 合法配置解析；
- schema version、未知字段、HTTP/private URL、越界值和敏感字段拒绝；
- 旧 `docling_config` 只保留 API Key；
- 默认备份与显式凭据备份行为；
- 官方配置变化会改变 parser/cache identity。

### Client 和 IPC

- 所有转换固定命中 `https://docling.example.com/v1/convert/file`；
- 请求包含完整 OCR、公式、表格、layout 和 image 参数；
- 普通转换与 summary 转换共享官方参数；
- 60 秒 abort timer；
- redirect、认证、invalid JSON、bounded response 和 partial success；
- IPC 拒绝多余 URL/timeout/feature 字段；
- trusted-frame 测试继续覆盖新参数形状。

### UI 和 store

- 设置页不存在 URL、timeout、OCR、公式或表格输入；
- 只读展示官方服务地址；
- API Key 保存、未保存离开保护和连接测试；
- 旧设置初始化后 API Key 仍可用；
- 错误提示不建议本地或 SSH 方案。

### 仓库防回归

增加源码扫描测试，至少阻止以下内容重新进入生产代码：

- `doclingTunnel` / `ensureManagedDoclingTunnel`；
- `SSH_HOST` 和 SSH `-L` 端口转发；
- `http://127.0.0.1:5001` / `http://localhost:5001` 作为产品默认值；
- 历史私人 IP；
- 设置页中可编辑的 Docling URL、timeout、OCR、公式或表格控件。

测试 fixture 可以使用 loopback mock server，但必须与生产默认值扫描区分。

## 11. 文档更新

实现时同步更新：

- `docs/architecture/overview.md`；
- `docs/architecture/modules.md`；
- `docs/architecture/data-flow.md`；
- 新增 `docs/architecture/configuration.md`，记录官方配置和故意保留的常量；
- 根目录及 `electron/`、`src/`、`src/stores/`、`src/views/`、
  `src/utils/` 下的 `AGENTS.md` / `CLAUDE.md` 相关描述；
- 设置页面向用户的隐私与服务不可用说明。

## 12. 硬编码审计结论

本交付负责移除或集中以下 Docling 运行时字面量：

| 类别 | 当前状态 | 目标状态 |
|---|---|---|
| SSH 主机/用户/端口/参数 | 生产代码写死 | 删除 |
| Docling base URL | 默认 loopback，用户可改 | 官方 JSON 唯一来源 |
| 请求超时 | 用户设置 + 测试另有 30 秒 | 官方 JSON 固定 60 秒 |
| OCR/公式开关 | 用户设置 | 官方 JSON 固定开启 |
| table/layout/engine/preset | client 内字面量 | 官方 JSON 集中定义 |
| 图片包含与 scale | client 内字面量 | 官方 JSON 集中定义 |
| API Key | 与部署参数混在同一对象 | 独立用户凭据 |
| Settings 帮助文字 | 历史主机漂移 | 从官方配置派生 |
| parser/cache identity | 手写 preset 标签 | hash 完整官方配置 |

其他仓库硬编码按以下原则处理，不在本交付中机械外置：

- 协议/schema/cache version、安全大小上限和并发上限保留为代码常量；
- E-k5 模型与检索参数属于算法契约；
- benchmark 参数属于可复现评测契约；
- provider preset、安装脚本仓库地址、Electron 下载镜像和应用版本显示是独立配置议题，可在后续任务处理；
- UI 尺寸、动画和 debounce 属于实现常量。

## 13. 验收标准

1. 生产源码不再包含 Docling SSH 或本机服务连接路径。
2. 所有 PDF Docling 请求只使用项目级官方配置。
3. 官方默认 URL 为 `https://docling.example.com`，超时为 60 秒。
4. OCR、公式、表格、layout 和 image 参数来自同一只读配置。
5. 设置页仅允许用户编辑 API Key。
6. 旧 API Key、备份脱敏和显式凭据导出保持兼容。
7. 服务不可用时给出明确错误且不回退。
8. 配置、client、IPC、store、UI、迁移和防回归测试通过。
9. `npm run typecheck`、`npm test` 和适当的构建检查通过。
10. 架构和配置文档与实际代码一致。
