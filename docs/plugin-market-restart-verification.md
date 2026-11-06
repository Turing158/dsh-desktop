# 插件市场重启与标题栏修复

## 原因

dshmarket 的“立即重启”优先调用 `window.__dshHostShell.restart`。桌面端此前没有提供这个接口，市场会回退到自己的 detached 重启助手，终止桌面端管理的 DSH 子进程并自行启动替代进程。

桌面端收到原进程输出流结束后，把后台标记为停止。替代进程没有经过桌面端的启动、窗口权限授权和界面恢复流程；标题栏继续显示，但拖动、最小化、最大化和关闭命令无法通过当前后台来源校验。

## 修改

- 在桌面端注入的界面状态桥中实现市场宿主重启接口，复用 `remote_status` → 界面快照 → `plugins_restart` 流程。
- 重启成功后由桌面端更新后台地址及权限，并恢复草稿、附件和布局；重复请求合并，直至新页面接管。
- 保存失败或宿主拒绝重启时保留原后台、释放本次输入锁，显示可重试的提示。
- 市场重启时允许其设置外壳和临时搜索筛选框通过快照检查，密码、其他未适配字段、独立弹窗和确认框仍需要处理后才能重启。
- 普通浏览器和子框架不注册宿主重启接口，已有宿主接口保持可用。

## 自动验证

`node --test dsh-plugin/ui-state.test.mjs dsh-plugin/titlebar-boot.test.mjs dsh-plugin/title-bar-remote.test.mjs dsh-plugin/plugin-control.test.mjs dsh-plugin/remote-control.test.mjs`

124 项通过，覆盖重复重启、身份与快照传递、保存失败、宿主拒绝后重试、窗口控制、市场搜索框以及其他表单检查。

`cargo build --manifest-path src-tauri/Cargo.toml` 构建通过。

本次执行的完整插件测试中，769 项有 768 项通过，1 项已有失败：`account and existing settings adapters converge in either load order without duplicate priorities`。该测试从其他设置源码截取函数时遇到 `SyntaxError: Unexpected token 'async'`，涉及现有通知设置改动，与本次重启桥接文件无关。

## 真实桌面验证

验证脚本：`node tools/dshmarket-desktop-restart-smoke.mjs`。

脚本使用独立 DSH_HOME、独立桌面状态目录和复制的 debug 程序，安装 dshmarket 1.73.11 后通过市场接口更新，再点击真实“立即重启”按钮。仅运行测试实例，不修改用户的配置与插件。

2026-11-07 验证通过：dshmarket 从 1.73.11 更新到 1.73.13，点击市场自己的“立即重启”后完成新后台启动和界面恢复。

- 未发送草稿及附件内容保留，监听配置不变，旧页面身份被拒绝。
- 标题栏最大化及还原成功，原生窗口状态与按钮行为一致。
- 使用物理鼠标拖动标题栏，确认原生窗口位置改变。
- 使用物理鼠标点击最小化，并通过应用的显示入口恢复。
- 点击标题栏关闭按钮，确认同一个主窗口 HWND 已隐藏到托盘，后台进程继续运行。

测试进程已结束。结构化结果保存在 `docs/plugin-market-restart-result.json`，不依赖清理后的 target 目录。
