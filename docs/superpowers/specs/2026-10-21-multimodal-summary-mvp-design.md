# 多模态原文摘要与自动素材库 MVP

日期：2026-10-21

状态：用户已确认并授权两名 agent 实现；实现与验证记录见对应计划及 docs/testing/multimodal-summary-mvp.md。

## 目标与已确认意图

用户希望先把产品跑通，不再让摘要功能依赖当前有问题的 Docling 服务。PDF 和网页预览都交给多模态模型理解，复用已经实测的英文提示词，生成包含原文图片、LaTeX 公式和出处的 Markdown 摘要。新文档进入产品时，模型自动识别素材区域，应用实际裁剪并建立该文档自己的素材库，供之后的摘要复用。

成功标准是导入、预览、自动准备素材、生成摘要、后台执行、保存回看这一整条流程可用。当前默认模型沿用已配置并实测的 deepseek-flash。第一版接受分钟级首次处理，不同时开展模型竞赛、复杂提速或全文 Markdown 还原。

## 已验证现状与限制

- PDF 摘要面板和聊天 /abstract 当前共用 src/stores/chat.ts 中的 Docling 摘要流程；新流程必须同时替换这两个入口的依赖。
- 现有 requestCompletion 的 content 是字符串，必须增加独立的多模态请求边界，不能只修改模型名。原有文字问答调用应继续工作。
- PDF 摘要任务已有应用级状态，切换路由或论文不应取消任务。网页问答控制器会在切换选择时取消请求，网页摘要不能直接复用这个生命周期。
- 网页预览目前提供 HTML/MHTML 快照，没有网页摘要面板；需要新增摘要入口以及稳定的视觉采集。
- Markdown 已支持公式和本地素材显示，但素材读取依赖 Docling 命名的 API。新素材需要独立于 Docling 服务，旧素材仍须可读。
- 53 页 2412.19437v1.pdf 的原貌图像输入实测：总请求 92.39 秒，首段正文 79.48 秒，输入 54,236 Token，输出 10,760 Token，其中思考 7,859 Token。实际送入的是逐页渲染图片，不是 PDF 字节。
- 该试验的四张配图由应用外提前裁剪。产品内不能把这种人工辅助视为已经实现的自动提图能力。模型原始输出还出现公式下标、出处及部署规模表述问题，不能承诺完全准确。

## MVP 范围

1. 新 PDF 成功导入、网页首次保存为稳定快照后，后台自动准备页面及素材库。已有文档第一次生成摘要时按需补建。
2. 自动素材准备不阻塞导入或阅读。摘要仍由“生成摘要”按钮或 /abstract 显式触发；若素材准备尚未结束，摘要任务等待同一准备任务。
3. PDF 面板、/abstract 和网页摘要共用生成核心。网页普通问答保持现状。
4. 生成完整摘要后持久化正文、素材引用、来源版本、模型和提示词版本、耗时及用量。模型错误应直接展示，不能静默切回 Docling 或纯文字摘要。
5. 保留旧 Docling 缓存和历史摘要读取。新生成不检查 Docling 健康或启动 SSH 隧道。不在本任务中删除 Docling 服务、旧数据或所有相关设置。

## 统一的原文与页面输入

定义 SummarySource，区分 paper 和 web-snapshot；每个来源版本有稳定 ID、内容指纹和页面清单。页码在模型协议和 UI 中为从 1 开始，在内部转换为明确的从 0 开始索引，不混用。

PDF 由现有 PDF.js 渲染完整页面，包括扫描页和矢量图；不先进行 OCR、Docling 或 LiteParse 解析。渲染保存像素尺寸和页面顺序，供坐标校验和裁剪使用。MVP 按页顺序渲染并释放画布，使用 print intent 避免后台 requestAnimationFrame 阻塞；页面图像暂保存在有界内存数组中，单篇最多 120 页、图像数据共 48 MB，超限不发模型请求、不丢页。批量 PDF 的自动准备串行执行。页面磁盘缓存暂未实现，重复准备需要重新渲染；裁剪素材和已完成批次会持久保存。

网页处理对象是已保存的一个快照版本，不能仅把网址发送给模型。在首次保存已加载页面时，以屏幕样式 printToPDF 固定视觉副本，保留当时的图片和公式字体，随同 HTML 一起保存；动图是该时刻的静态帧。摘要阶段只读取这份不可变 PDF，不借用正在浏览的页面。页序号标记为网页快照页序号，不伪装成网页原有页码。旧缓存没有视觉 PDF 时，仍可在受隔离的离线 Electron 视图恢复 MHTML，检查字体、图片和公式是否完整后导出；不能可靠恢复时明确要求更新快照。

初次采集进行有界资源准备：提升原生懒加载、加载网页声明的原图、滚动有限正文范围；不点击交互控件或猜测未声明的资源。准备后短暂暂停页面脚本，在同一检查点保存 HTML、视觉 PDF 和 MHTML，并校验 URL、页面代次和 DOM 一致性。成功或失败均恢复脚本、滚动及 loading 标记；发生导航即拒绝保存混合来源。固定高度滚动内容无法在在线打印中完整展示时明确失败，可由保留了完整资源的离线 MHTML 路径展开后处理。无法恢复原貌的旧 HTML 缓存显示更新快照提示，不能静默丢弃图片继续。当前快照不包含的链接页面不在摘要范围内；不自动遍历整站，不声称读过整本书。

## 自动素材准备

页面渲染 -> 模型识别素材清单 -> 本地验证、裁剪 -> 素材与出处入库。

### 模型定位

使用专门的素材定位请求读取所有待处理页面，返回 JSON 清单。支持 figure、diagram、chart、table、equation；保存识别到的有用素材，摘要阶段再选择使用，不要求每项都进入摘要。页眉、Logo、导航及装饰不作为正文素材。公式以独立展示公式为主要对象，不裁剪每一个行内符号。

素材记录至少包含模型原图号或公式号、原文图注（无则留空）、PDF/快照页序号、归一化区域、类型以及可选的模型解释或 LaTeX。模型解释和转写标记为派生内容，图片像素才是原文证据。MVP 不保证素材识别完备，不以未发现素材推断原文不存在。

长文档按输入上限分批识别，记录每批覆盖的页面；所有页处理结束前不标记素材准备完整。无可用图片的纯文字文档可以有空素材库。

### 本地实际裁剪

模型仅提供位置，不负责生成像素、不访问本地文件。应用校验页号及坐标，再从对应 PageFrame 裁剪真实图片。坐标统一以左上角为原点，范围为 [0,1]；拒绝非有限数、负数、空框和越界框，不靠任意夹紧坐标把错误伪装成有效区域。模型报告的页尺寸和应用页面不一致时不直接裁剪。

每项素材记录裁剪状态。无法可靠定位时保存失败原因和对应完整页面作为回看依据，标记为“原文页面，未精确裁剪”，不得标成精确原图。失败不会阻止文字摘要，但正文须说明无法提取的视觉位于何处，不能留下不存在的图片引用。可以重试失败区域，不重做已成功素材。

### 素材库与缓存

每份文档版本拥有素材清单；底层图片可按内容哈希去重，但素材关联仍保留各自来源、页码及区域。缓存键包含来源内容指纹、页面渲染版本和定位协议版本。文件原地替换、网页外观变化、截图规则变化均产生新版本，不能把旧坐标套到新原文上。

网页身份沿用实际 snapshotId 及外观指纹，不仅按 URL 或 HTML 文字哈希判断。生成摘要的提示词变更不强制重新裁剪；可继续复用对应来源版本的有效素材。

素材库第一版是内部可复用数据和摘要中的原图放大，不新增独立的素材管理工作台、人工标框编辑器或全局图片搜索。

## 摘要生成与组装

素材库就绪后，向同一多模态模型发送原文页面、素材清单与稳定素材引用规则，并使用用户提示词生成最终 Markdown。MVP 采用两个明确阶段，首次处理可能需要两次或多批模型请求；不以此前 92.39 秒单次请求承诺产品耗时。

默认使用现有 deepseek-flash 配置和图片输入；发送全页以保留上下文，不能只发送素材图片。后续接收原始 PDF 的服务商可以通过相同文档请求边界适配，本轮不同时实现全部服务商。对不能处理图片的配置明确报错，不隐式降级成仅文本。

模型通过应用提供的稳定 asset ID 引用原图。应用只解析白名单素材引用并替换为本地素材地址，不接受模型指定的任意本地路径或图片 URL。素材与文档版本不匹配、缺失或区域失败时，输出明确的出处/限制提示，禁止用模型生成的替代图填充。摘要内容及图片链接均经过现有 Markdown 安全处理。

公式用 LaTeX 渲染并关联模型给出的编号和页码。保存公式原始区域截图供核对；读不清的公式保留原文位置，不通过猜测补齐。不会因公式能被 KaTeX 渲染就声称其语义已验证。MVP 不自动加入人工校对后才有的修订内容。

### 用户提示词（逐字保留）

```text
Read the provided PDF directly, examining both its text and relevant visual content, and produce a concise, self-contained summary. Capture the document’s central purpose, main ideas, essential reasoning, and most important findings or conclusions. Adapt the structure and emphasis to the document type. Organize the summary around its core narrative rather than summarizing every section equally, and prioritize meaningful explanations over exhaustive detail or lists of numerical results. When an original figure, diagram, or equation substantially improves understanding of a key idea, incorporate it at the relevant point in the summary. Extract and embed the actual image from the PDF rather than generating a substitute or merely inserting a placeholder. Reproduce essential equations faithfully in LaTeX, preserving their notation, and briefly explain the important symbols and what the equation contributes to the discussion. For every included visual or equation, explain the specific insight it supports and cite its original identifier and PDF page number when available. Use these elements selectively and keep the surrounding explanation accessible. Ground all claims in the document, preserve important qualifications, and do not invent missing content. If an image cannot be extracted or an equation cannot be read reliably, state that limitation and refer to its location instead. Return only the finished summary in clear, well-structured Markdown.
```

保留原文中的 PDF 措辞。单独的协议说明在网页场景解释：所附页面来自指定网页快照，页号是快照页序号；在 DeepSeek 场景解释输入是未经内容解析的原文页面渲染图，并提供可用素材 ID。协议说明不擅自更改摘要语言、浓缩正文或注入另一个摘要写作提示词。输出语言沿用本次实测行为，不添加未确认的中文强制要求。

## 任务生命周期、持久化与兼容

- 应用级任务按来源版本去重。素材任务和摘要任务分开，摘要等待素材任务；切换 PDF、网页、会话、路由不取消准备或生成。
- 导入批量文档产生的准备任务排队，默认并发一个文档，避免一次性大量视觉请求。用户主动停止和删除来源有明确取消路径；取消后晚到响应不能写入已取消任务。
- 创建任务时固定模型配置、来源版本和提示词版本。用户之后换模型或网页导航不影响正在执行的任务。
- 完成结果持久保存，重新打开无需重复付费请求。重新生成摘要可复用素材；重新提取素材是单独动作。
- 阶段状态为 queued、rendering、locating、cropping、summarizing、completed、failed、cancelled；显示文字进度，不编造模型推理百分比。
- 网络失败、无效素材 JSON、上下文超限和输出截断均有可读错误，不静默截掉来源页面。摘要截断保留已有内容并允许续写，复用原文和素材。
- 应用退出或崩溃后不承诺任务继续执行。重启识别未完成状态并允许重试，保留已持久化的有效页面、素材批次及完成摘要，不显示永久生成中。
- 数据库增加来源版本、素材、任务和网页摘要的必要关系；复用现有持久化能力，避免更改无关问答行为。改数据库 API 时同步 schema、repository、preload、IPC 类型与校验；备份导出/导入和删除级联必须包含新增数据。
- 历史 Docling 素材与摘要保持读取，不能单纯提高旧缓存版本导致历史摘要全部不可见。第一版新默认路径不调用 Docling 服务，旧设置不阻塞新任务。

## 接入位置

- PDF 导入完成处：提交素材准备任务；失败不回滚成功导入。
- src/stores/chat.ts：PDF 摘要面板与 /abstract 转到统一摘要服务，继续维护兼容的后台状态及引用。
- src/views/WebPreviewView.vue 及摘要面板：新增摘要视图，绑定已选快照；使用应用级摘要状态，不借用随选择取消的网页问答控制器。
- electron/webPreview.ts：增加与当前交互视图隔离的快照视觉采集能力，暴露受校验的 IPC。
- 新增独立的多模态请求、页面/素材协议和摘要编排模块；不继续把新功能都塞进 chat.ts 或 Docling 工具。
- 本地素材仓库、Markdown 图片读取以及备份：扩展通用资产读取能力，保持旧 Docling ID 的兼容。

## 验证与验收

自动测试集中验证有风险的行为：多模态请求确实携带页面；提示词保持一致；页号/归一化坐标和旋转页裁剪转换；拒绝非法路径与素材引用；相同来源准备去重；失败和取消后的晚到结果；快照变化后来源绑定；数据库迁移、备份和素材级联；缓存摘要回看；截断续写；切换路由后台完成。

真实端到端验证：

1. 使用 2412.19437v1.pdf，Docling 不可用时仍能从导入/首次使用准备素材，生成含真实原图和 LaTeX 的摘要。关键架构图、MTP 图及公式可在原页回看。
2. 使用已讨论的 RL-without-Tears reader 网页，确认保存的是当前已加载页面，原貌和公式采集完整；若该页面是动态加载或仅显示一章，必须明确实际快照范围，不声称覆盖整书。
3. 准备与摘要期间分别切换功能、文档和网页；原任务继续，结果写回原来源；重新进入后正确展示。
4. 重复生成摘要不重复识别已有素材；刷新网页得到新快照后不混用旧图。
5. 网络失败、模型不支持视觉、无效坐标及长文档超限均有可恢复提示，不能伪造成功。
6. 重启应用后完成摘要及图片仍可读；未完成任务显示可重试状态。

运行项目已有 npm run typecheck 和 npm test。完整安装包构建是否执行依据实现后涉及的 Electron/打包改动决定。记录首次准备、素材定位、裁剪、首段正文、摘要总耗时和 Token，用原始模型结果评估质量，不把人工校对混入自动效果。

## 暂不包含

完整 PDF-to-Markdown 还原、全部行内公式识别、跨网页自动爬取、Docling 服务修复/卸载、完全本地视觉模型、多服务商同时接入、关闭应用仍在运行的独立守护进程、素材人工编辑工作台，以及没有实测支持的速度或准确率承诺。
