# Multimodal Summary MVP Implementation Plan

> **For agentic workers:** Use coordinated parallel agents for PDF and web tasks, as explicitly requested by the user. Root owns shared persistence/IPC and integration. No commits, pushes, merges or destructive cleanup are authorized.

**Goal:** PDF 与网页自动建立真实裁剪素材库，并共用直接视觉理解的摘要流程。

**Architecture:** PDF.js 渲染原文页面，独立网页视图将已保存快照转成原貌 PDF 后共用渲染。先定位素材、实际裁剪并缓存，再使用原始提示词生成引用本地素材的 Markdown。应用级任务管理跨路由状态，SQLite 保存素材、阶段缓存和摘要。

**Tech Stack:** Vue 3, Pinia, PDF.js, Electron, SQLite, Vitest, configured multimodal Chat Completions endpoint.

**Spec:** ../specs/2026-10-21-multimodal-summary-mvp-design.md

## Global Constraints

- 用户提示词逐字保留；Docling 不参与新摘要生成。
- 同来源版本复用素材；历史摘要和旧素材仍可读；网页只处理当前快照。
- 模型定位、应用裁剪真实像素；非法坐标不伪装精确提图。
- 后台任务绑定来源和模型，路由切换不中断，完成结果持久化。
- 不静默丢页、不降级纯文字，不持久化密钥，不接受模型指定任意文件路径。
- 所有数据库 API 同步 schema/repository/preload/IPC/type/backup。

## Review Focus

- 切换网页或删除来源时，晚到模型响应不能混写或复活已删除数据。
- 相同文本但不同网页外观不共用旧裁剪坐标。
- PDF 扫描页、旋转页、矢量图来自真实页面像素。
- 模型返回非法 JSON/框/图片引用时明确失败或标注原页。
- 原貌缓存缺失、超限或生成截断时不显示完整成功。

## Shared interfaces and write ownership

Root owns src/types/documentSummary.ts, src/types/ipcContract.ts, electron/{ipc,preload}.ts, electron/db/{schema,index,backupValidation,documentSummary}.ts, src/tests/setup.ts and MarkdownContent asset fallback. Record API is get(kind,sourceId,slot), save({kind,sourceId,slot,sourceHash,payload}), saveAsset(kind,sourceId,data), readAsset(id). kind is paper|web; slot is materials|report|task. Payload is JSON and must never contain provider credentials.

PDF agent owns src/utils/visualSummary*.ts, src/stores/{visualSummary,chat,paper,libraryImport}.ts and PDF entry tests. Shared renderSummaryPdf(base64,onProgress?) returns pages {page,width,height,data}. Shared input {kind,sourceId,title,sourceHash,pages}; store prepare(input,profile), generate(input,profile,force?) and states keyed kind:sourceId.

Web agent owns WebPreviewView, WebAbstractPanel, web summary/history composables, electron/webSummaryCapture.ts (captureWebSummaryPdf(snapshot):Promise<base64>) and relevant tests. Root wires preview:summaryPdf(snapshotId).

## Task 1: Source-owned persistent cache and assets (root)

- [x] Write failing repository tests for paper/web foreign ownership, get/save validation, real image bytes, deletion cascade, backup roundtrip and rejection before restore mutation.
- [x] Implement document_summary_records and document_summary_assets, guarded shared validation and repository; record slots carry versioned JSON, assets are SHA-256-addressed PNG/JPEG/WebP.
- [x] Wire typed IPC/preload and setup mocks; return assets through generic reader with old Docling fallback.
- [x] Extend atomic backup export/import and clear/delete ownership behavior.
- [x] Run focused repository/IPC/backup tests and typecheck integration.

## Task 2: Shared model pipeline and PDF entry (PDF agent)

- [x] Write/run failing tests for exact prompt, image-bearing request, crop validation, source-version cache, asset reference allowlist, cancellation and no Docling calls.
- [x] Implement page rendering, budgeted visual requests, material JSON parsing/local cropping and persisted reuse.
- [x] Implement app-level task state, queue, stage persistence, progress, truncation continuation and source/model capture.
- [x] Replace PDF panel and /abstract generation; auto-prepare newly imported PDFs; preserve legacy cached report reads.
- [x] Run focused pipeline/store/import/lifecycle tests; report exact evidence and residual issues.

## Task 3: Web capture and summary entry (web agent)

- [x] Write/run failing tests for saved snapshot binding, source switching/unmount survival, missing archive and capture cleanup.
- [x] Implement isolated snapshot-to-PDF capture with bounded resource settling, source validation and cleanup.
- [x] Add webpage summary tab/panel following PDF UI, retain QA and preview behavior.
- [x] Reuse shared pipeline and persist summary keyed snapshot; trigger material preparation on stable archive creation.
- [x] Run focused UI/capture/lifecycle tests and report evidence.

## Task 4: Integrate and verify (root with both agents)

- [x] Review both implementations for spec compliance and quality, exchange scoped review findings and fix blockers.
- [x] Run npm run typecheck and npm test, then build bundles where relevant; inspect current complete diff.
- [x] Exercise actual PDF and webpage paths with controlled local artifacts/configuration where available. Keep real app data intact; no unrequested import/deletion or extra broad paid benchmarks.
- [x] Confirm image display, formula rendering, cached reload, switching behavior, and no Docling dependency. Document anything not actually exercised.
- [x] Update design/plan with actual interfaces and validation results; deliver working-tree changes and concise limitations. Do not commit/push.

## Execution decisions

The user reviewed the design and explicitly requested two agents and immediate implementation. This supplies the execution method and authorization; do not repeat an approval question. Agents share this branch but write disjoint file sets. Any shared interface changes are coordinated through root before edits.

## Verification and implementation refinements

- Final npm test:160files,2,032Vitest tests plus19branding script tests passed. npm run typecheck and npx vite build passed; no installer packaging claimed.
- Actual isolated Electron +configured deepseek-flash: original PDF pages7/10 excerpt,2page visual input,7actual material assets,2images selected in summary,48.51seconds,not truncated. No manual figure list supplied.
- Actual crop QA exposed tight model boxes; added validated padding, full-line equation regions, actual cropBbox metadata, and rechecked all7crops offline without another model request.
- Actual RL reader capture:58page3,566,527byte visual PDF,1,718ms capture/replay; observed original figures,154KaTeX nodes at source and finalreferences preserved. Did not submit whole web book to paid inference.
- MHTML-only capture could not retain source KaTeX fonts and exceeded32MiB foranimatedRLbook. Save a live screen-style visual PDF with the snapshot, then generate from saved bytes; preserve offlineMHTML compatibility. NewvisualPDF persistence,sourcefingerprint,dedup,backup,restore tests coverthis path.
- Renderer PDF.js display intent paused in hidden window; print intent removed requestAnimationFrame dependency, confirmed realElectronrender completes.
- BoundedMVP:OpenAI-compatible vision profile,120pages/48MB pageimages,no disk-backed page cache yet. Automaticmaterials preparation may take multiple calls; no latency promise.
- Workingtree only; no commits/push, no user PDFs,databases,keys or generated bundles added to tracked deliverables.
