# 运行时存储与清理

Windows 默认应用目录是 `%APPDATA%\com.deepseek.harness.desktop`，其中的 `runtime` 保存本应用管理的 dsh 依赖快照和安装缓存。反复开发、准备更新、取消或重试更新都会产生这些内容，正式用户使用更新功能也适用同一保留策略。

| 内容 | 保留规则 |
| --- | --- |
| `runtime/versions` | 平时只保留当前选择及正在运行的版本。更新期间临时保护候选版本与旧版本，后台和界面恢复全部提交后回收旧版本，并清空 `selection.json.previous`。 |
| `runtime/candidates`、`runtime/installing` | 仅用于安装与探测。候选准备结束后回收安装目录；首次安装提交后回收安装目录。失败、取消和遗留目录在维护期间或下次健康启动回收。 |
| `runtime/versions/.preparing-*` | 完成或失败的冻结立即回收；中断残留在健康启动时回收。 |
| 相同依赖快照 | 包版本、入口、文件列表、内容与 Node 绑定一致，并且现有快照重新校验通过时，复用同一目录。内容已变化或损坏时重新生成。 |
| `runtime/npm-cache` | 首次安装和候选安装共用。准备结束或健康启动时检查 512 MiB 预算；超出后通过 npm 清理本应用的安装包缓存和 npm 日志，并复查大小。安装过程中可能暂时超过预算。 |

清理在维护协调器的独占操作中执行，另一桌面进程还需取得运行时仓库锁。启动、安装、更新、数据恢复和页面恢复尚未完成时等待，当前候选版本的准备与切换不会和清理同时写入仓库。存在未提交或无法识别的更新记录时停止回收，以保留恢复所需的版本。

冷启动结束时和页面加载完成时都会请求回收。WebView2 的首次页面加载可能早于后台就绪，因此启动回收不依赖额外的页面刷新；实际运行条件尚未满足时，维护工作会释放独占操作并等待重试。

回收只接受明确的归属记录，包括有效运行时清单、安装归属标记、旧版候选准备记录及绑定到确切目标的冻结请求。用途未知的目录、会话、用户配置、全局 npm 安装和外部目录联接目标保留。显式指定的外部运行时入口也会保护它实际使用的仓库路径。

`runtime/cleanup-report.json` 保存最近一次清理的计划、已删除项、延期项和回收字节数。删除前写入 `runtime/cleanup-pending`，使文件占用或中断后仍可识别部分删除的目录；未完成项在后续维护或下次健康启动重试。回收失败会记录诊断，不会把已经成功的升级改成失败。

开发集成测试使用 `DSH_DESKTOP_SMOKE_DIR` 隔离运行时、语言缓存和 WebView 数据。测试无需为语言缓存创建 `com.deepseek.harness.desktop.*` 的 Roaming 目录；旧目录不会仅凭名称被删除。测试临时文件应放在仓库 `target` 内，并在验证结束后执行 `npm run clean:target`。

验证入口：`npm run test:runtime-snapshot`、`npm run test:runtime-cleanup`、`npm run test:runtime-candidate`、`npm run test:runtime-store` 和 `npm run test:runtime-upgrade`。原生测试先构建独立测试标识的 debug 程序；可将首次安装测试产生的隔离目录传给 `DSH_UPGRADE_SOURCE_ROOT`，验证真实受管理版本在升级提交后只保留新版。
