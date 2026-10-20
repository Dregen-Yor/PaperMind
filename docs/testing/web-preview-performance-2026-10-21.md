# 网页导入性能实验（2026-10-21）

固定页面：[RL without Tears](https://niutrans.github.io/RL-without-Tears/reader.html)。基线为 `b114264`；逐轮数据见 [JSON 记录](./web-preview-performance-2026-10-21.json)。

结论：保留 **独立持久 Chromium 会话缓存 + 默认网络策略**。完整缓存建立后，新进程再次访问三轮完整加载中位数为 **335 ms**。预连接、强制 HTTP/1、图片并发限制没有显示出稳定的额外收益。此结果适用于缓存复访，**不能证明首次访问已经加速，也不能据此计算相对基线的完整加载加速倍数**。

## 测量方法

- 直接运行实际 `PreviewController.openAndCapture`，每个样本启动新的真实 Electron 进程，使用独立测试配置目录，不访问应用数据库。测试覆盖网页导航、渲染及快照采集；不包含 Electron 启动、Vue 路由切换、粘贴操作或数据库写入。
- Linux x64，Electron 44.2.0 / Chromium 152.0.7977.76；与应用保持相同的 GPU 禁用设置、沙箱及网页安全策略。默认使用当前系统代理，端点不写入汇总。直连仅是单独实验，没有修改系统设置。
- 始终访问同一 URL，没有删减、替换、懒加载或屏蔽网页资源。所有采集到页面内容的样本均核对 23 张图片、154 个 KaTeX 节点及正文 SHA-256：`ac9ffee7e906aa46e10d02fe3906bda5254af1fb12b1c600403bbc24fc228d67`。
- FCP 是 Chromium 首次内容绘制时间；完整加载要求 `document.readyState=complete`、全部图片 `complete && naturalWidth > 0`、字体就绪且无字体错误、无其他非取消资源失败或 HTTP 错误（不计 favicon）。完整加载时间取导航结束后的字体就绪时间；绘制呈现调度可能令 FCP 略晚于该时间。它不表示等待 GIF 动画播放结束。
- `captureMs` 单独记录快照采集结束。MHTML 保存失败不判为网络页面未完整加载。早期版本 1 曾将存档成功纳入条件；这些样本同时缺图，本报告仍判为不完整，不用于完整加载比较。版本 2 分离了字体就绪、快照结束和存档结果。
- 每个冷启动样本使用全新配置；持久会话复访共用配置，但每次都是新进程。前期复访可能只有部分资源缓存；后期仍可能发生缓存到期或回源。失败后已下载资源会影响后续复访，不能把它们当成彼此独立的首次访问。
- 测试按顺序进行，没有并行下载互相竞争。不同超时上限用于诊断筛选及延长等待，超时是未完成结果，不是加载耗时。样本较少且网络波动明显，结论限于本次环境。

## 冷启动及部分缓存实验

时间单位为秒；“完整加载”列只填写通过资源完整性校验的结果。

| 样本 / 方案 | 上限 | FCP | 完整加载 | 最终图片 | 结果 |
| --- | ---: | ---: | ---: | ---: | --- |
| baseline-cold-1：原实现 | 120 | 1.796 | — | 7/23 | load 事件在 75.068 s 发生，但缺图 |
| http1-cold-1：强制 HTTP/1 | 120 | 10.080 | — | 21/23 | 超时 |
| preconnect-cold-1：预连接 | 120 | 26.156 | — | 10/23 | 超时 |
| persistent-cold-1：持久缓存首次访问 | 120 | 8.760 | — | 1/23 | load 事件在 46.123 s 发生，但缺图 |
| persistent-restart-1：持久缓存复访 | 120 | 0.376 | — | 12/23 | 超时 |
| persistent-restart-2：持久缓存复访 | 120 | 0.304 | — | 20/23 | 超时 |
| images4-cold-1：图片并发最多 4 个 | 240 | 2.944 | — | 19/23 | load 事件在 97.164 s 发生，但缺图 |
| persistent-images4-1：持久缓存 + 图片并发 4 | 240 | 11.460 | — | 20/23 | 超时 |
| direct-cold-1：直连 | 90 | 15.820 | — | 6/23 | load 事件在 75.593 s 发生，但缺图 |
| persistent-restart-3：持久缓存复访 | 120 | 28.240 | — | 21/23 | 超时 |
| persistent-http1-1：部分缓存 + HTTP/1 | 300 | 0.280 | 28.841 | 23/23 | 完整成功，随后用于完整缓存复访 |

HTTP/1 组合在部分缓存条件下取得首次完整成功，只说明这一轮下载成功，不能与冷启动样本直接比较来断言 HTTP/1 更快。此前只凭 load 事件得到的约 13.2 秒，也不满足本报告的完整加载标准。

## 完整缓存建立后的组合对照

下表单位为毫秒。每项三轮，每轮独立进程，全部 23/23 图片、154 个公式及正文指纹通过。第一批交替测试默认策略和预连接；第二批交替测试默认策略、HTTP/1、图片并发 4、预连接 + HTTP/1。

| 方案 | 三轮完整加载 | 中位数 | 判断 |
| --- | --- | ---: | --- |
| 持久缓存 + 默认策略（selected） | 289 / 335 / 442 | 335 | 保留 |
| 持久缓存 + 预连接（selected-preconnect） | 390 / 332 / 332 | 332 | 差 3 ms，未显示稳定增益 |
| 持久缓存 + HTTP/1（final-http1） | 385 / 401 / 360 | 385 | 无额外收益证据 |
| 持久缓存 + 图片并发 4（final-images4） | 374 / 360 / 336 | 360 | 无额外收益证据 |
| 持久缓存 + 预连接 + HTTP/1（final-preconnect-http1） | 412 / 308 / 349 | 349 | 无额外收益证据 |

第二批默认策略对照 `final-default` 三轮为 **5170 / 304 / 414 ms**（中位数 414 ms），没有从记录中删除慢样本。第一轮出现 26 个非磁盘缓存响应，说明持久缓存不保证每次都免除网络等待；它与随后全部缓存就绪的样本条件不同。不能拿 5170 ms 与后续组合的几百毫秒直接计算组合收益。FCP、超时、资源完整性和每轮时间均保留在 JSON 中；调试器初始化可能漏记很早的响应，响应计数仅用于辅助解释，不代替 DOM 完整性检查。

所选方案是目前证据支持、改动最小的复访优化。没有找到可证明的首次访问最优组合，也没有证明预连接等措施存在统计上可靠的优势。

## 代码缺陷与保留改动

原 `PREVIEW_PARTITION = 'papermind-preview'` 是内存会话：应用重启后不能复用其资源缓存。改成 `persist:papermind-preview` 后，Chromium 可跨进程复用已下载资源，并继续遵循网站缓存规则。网页会话仍与应用自身隔离；站点 cookie 和存储也会随该会话持久化。

`data:clear` 同步接入持久会话清理：先关闭各窗口的网页视图，再清除 HTTP 缓存、站点存储及代码缓存。新增测试验证清理范围、其他会话不受影响，以及清理前关闭活动页面。

当前页面包含大动图：响应头测得 `fig-mcts.gif` 为 12,960,097 字节，`fig-step-verification.gif` 为 9,684,544 字节，`fig-bon.gif` 为 4,535,620 字节。实验中出现连接关闭及超时，解释了正文显示与全资源下载之间的巨大差异。持久缓存无法消除首次下载的网络成本。

另做一次 `archive-size-check`，仅在测试进程包装 `savePage`，读取生成文件大小：MHTML 为 **65,471,355 字节（约 62.4 MiB）**，超过当前 **32 MiB** 上限，因此完整页面可显示，HTML 快照可采集，但完整离线外观存档被现有保护逻辑放弃。该诊断样本单独记录，不加入性能组合排名。本次没有提高存档上限或更改存储方案。

## 复现

冷启动不传 `--profile`，脚本会创建全新临时目录：

```bash
node scripts/benchmark-web-preview.mjs --label=cold --timeout=300000 --output=bench/results/web-preview-local/cold.json
```

持久缓存实验指定专用目录，并重复启动命令、修改输出名：

```bash
node scripts/benchmark-web-preview.mjs --profile=bench/results/web-preview-local/profile --label=visit-1 --timeout=300000 --output=bench/results/web-preview-local/visit-1.json
node scripts/benchmark-web-preview.mjs --profile=bench/results/web-preview-local/profile --label=visit-2 --timeout=300000 --output=bench/results/web-preview-local/visit-2.json
```

组合实验分别添加 `--preconnect`、`--http1`、`--image-concurrency=4` 或它们的组合；`--direct` 测试直连。`--partition=papermind-preview` 可模拟原内存会话；`--source=/absolute/path` 可编译指定源码快照。实验开关只作用于基准进程，没有进入应用默认配置。需要可用的图形显示环境及已安装的 Electron 依赖。

完整原始输出及测试配置保留在本机忽略目录 `bench/results/web-preview-20261021/`；可分享的逐轮摘要位于本报告旁的 JSON，不包含代理地址、站点存储或用户数据库。临时构建与测试配置不会自动清除，以便复查和复访。

## 验证

- `npm test`：152 个 Vitest 文件、1981 项测试通过；另外 19 项脚本测试通过。
- `npm run typecheck`：通过。
- 两个新增基准脚本的 `node --check`：通过。
- `git diff --check`：通过。
