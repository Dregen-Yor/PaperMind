# E-k5 产品代码合入本地 main

源版本：`feat/Ek5` 的 `2dc46b45f2db6de6210eb3681be5fa9be4057129`，该提交保存了原分支全部产品与研究工作。整合基线为本地 `main` 的 `5eda077`，未 fetch、pull 或 push，也未访问 upstream。

## 合并范围

从 main 建立 `codex/ek5-product-integration`，整合正式问答 store、E-k5 本地索引与检索、PDF 文本/目录解析依赖、设置和准备状态、对应测试及产品文档。未整体合入源分支的实验历史：main 的 benchmark、package scripts 和依赖版本保持原状；PeerQA/QASPER 的新实验代码仍在 feat/Ek5。

正式产品的提问、重试和续写显式使用 `retrievalMode: 'ek5'`；模型或索引不可用时报告错误，不回退到旧检索。旧算法仍为既有 benchmark/兼容代码保留。划选原文问答和 `/abstract` 保持各自用途。默认输出上限仍为不限制。

## 合并前审查与修复

- 独立代码审查核对了所有正式调用入口、旧索引迁移、失败时保留旧记录、多篇论文来源映射、模型加载路径及依赖完整性。
- 修复 PDF.js 的数字目录目标解析：数字目标本身就是零基页索引，不能传给只接受对象引用的 `getPageIndex`。显式目标与命名目标新增两项测试；先确认两项失败，再修复通过。
- 产品回归测试不再导入实验 benchmark 模块。由源版本 benchmark 生成冻结 fixture，校验 4 组/7 组场景的完整上下文、选中顺序、Top-5 和 SHA-256 身份。
- 更新 README 和 WASM 资源告警，移除旧的词法降级承诺。忽略本地 dataset 和 prepared 产物，防止误提交。
- 复审未发现剩余合并阻塞项。之前 UX 报告中的跨语言召回、启发式章节质量、停止生成等改善项仍然保留，并未在此次整合中宣称修复。

## 验证

- `npm test`：105 个 Vitest 文件、1423 项通过；branding 18 项通过，1 项因本机缺少 Linux `desktop-file-validate` 跳过。
- `npm run typecheck`：通过。
- `npx vite build`：前端、Electron main 和 preload 资源构建通过；存在 bundle 大小提示。未重新生成安装包。
- `git diff --check`：通过。

这些是本次产品整合版本的检查结果。此前桌面操作和真实 API 体验见 [体验报告](2026-10-08-ek5-user-experience-review.md)；它们不是本次新增的全面桌面回归。

本地启动：在仓库根目录执行 `npm run dev`。首次本地向量模型下载需要网络，旧文献首次提问会按 E-k5 重建索引。
