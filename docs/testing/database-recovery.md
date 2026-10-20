# 数据库与 PDF 恢复一致性

论文元数据、对话和配置保存在 SQLite，PDF 单独保存在 `userData/papers/`。备份恢复、删除论文、删除知识库和清空数据必须同时处理这两部分。

## 操作和恢复顺序

`electron/db/paperFileTransactions.ts` 提供同步协调器，供数据库层调用：

1. 将本次所有新 PDF 写入同一 userData 文件系统内的暂存目录，写齐恢复清单。暂存失败不修改原 PDF 或业务记录。
2. 在 SQLite 事务中执行业务 SQL，将旧 PDF 移入隔离目录，再安装新 PDF。删除操作只隔离旧文件。
3. 在同一 SQL 事务中写入 `paper_file_transactions` 提交标记，再提交。
4. 提交失败则恢复隔离的原件；提交成功才清理旧文件和标记。

恢复资料位于 `userData/.paper-file-transactions/<UUID>/`，包含 `manifest.json`、`old/` 和 `new/`。清单只记录受管论文 ID，不接受任意文件路径。`paper_file_transactions` 是内部恢复表，不属于导出数据或 renderer IPC。

应用启动时先恢复未完成的文件操作，再迁移并提供业务接口。没有提交标记时恢复原件；有标记时保留已提交的新状态并继续清理。导入和删除也会先恢复，再确定本次要处理的旧文件，避免遗漏仍在隔离区的原件。导出同样先恢复；恢复仍失败时拒绝导出，不把隔离区里仍可恢复的原件当作缺失 PDF 写入备份。

普通文件或 SQL 错误会触发回滚。如果连恢复也被权限或 I/O 错误阻止，程序保留恢复资料并返回包含目录位置的错误，不宣称已经回滚成功；修复环境问题后可再次恢复。提交后的旧文件清理失败不会将已完成的业务操作误报为失败，恢复目录或标记保留到后续重试。不要手工删除尚未完成的恢复目录。

该机制处理进程中断及可恢复的文件操作失败，不承诺硬件损坏、所有断电情形或外部程序任意修改文件时的完整性。PaperMind 在启动数据库前获取 Electron 单实例锁，防止另一个应用进程将正在执行的操作误认为中断任务。

## 备份兼容规则

- 继续支持 version 1。`fileData` 为 `null` 或缺省时保留论文记录，但不复用恢复前同 ID 的 PDF；阅读入口将其视为原文缺失。
- 每个 `settings.value` 必须是合法 JSON。已知模型配置、Docling 配置等还需通过结构校验，失败时不覆盖现有资料。
- 未知设置允许任意合法 JSON；旧单模型迁移、缺省输出上限、空配置列表和历史语义树字符串布尔继续兼容。
- 设置校验错误包含键名，不回显 API Key 等设置值。
- 恢复成功后清理不在备份中的受管普通 PDF；不会借此遍历或删除数据库中任意外部路径。
- 文件操作会探测论文目录与恢复目录是否区分大小写；不区分时，拒绝将 `foo` 和 `FOO` 当作不同论文同时处理，避免隔离原件被覆盖。真正区分大小写的目录仍支持这类旧 ID。

## 自动验证

```bash
npx vitest run src/tests/backupSettingsValidation.test.ts src/tests/paperFileTransactions.test.ts src/tests/databaseRecovery.scenario.test.ts src/tests/ipcContract.scenario.test.ts src/tests/singleInstanceStartup.test.ts
npm run typecheck
npm test
```

测试使用临时目录和真实 SQLite，不接触用户资料：

- 第一或第二个 PDF 暂存写入失败、后续文件移动失败，原件、知识库、对话和设置保持一致。
- SQL 删除、提交标记及真正 COMMIT 失败后恢复文件和记录。
- 恢复过程再次失败时保留日志，解除故障后可重试；恢复和清理重复执行不会删除原件。
- 真实落盘日志经 `initDb()` 恢复，分别覆盖有／无提交标记。
- 缺失 PDF 的同 ID／新 ID 恢复，以及成功导入时的孤儿 PDF 清理。
- 删除论文、删除知识库和清空数据的失败回滚；恢复未完成时再次清空也不会遗漏隔离文件。
- 不安全 ID、symlink、目录目标、损坏清单、嵌套或异步事务被拒绝。
- Windows 路径故障注入和可写句柄的同步要求；Linux 上的平台模拟不等同于 Windows 安装包实机验收。
- 大小写不敏感的论文目录或恢复目录拒绝别名 ID；探测失败时不修改原件和业务记录。
- 单实例锁失败的进程不初始化数据库、IPC 或窗口，持锁进程处理第二次启动的聚焦请求。
