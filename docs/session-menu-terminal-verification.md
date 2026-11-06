# 会话菜单与 Windows 终端修复验证

验证日期：2026-11-06。

## 会话菜单

DSH 0.2.2-rc.1 将内置会话操作从 `sidebar.workspaces.session.menu.item`
迁移到 `contextMenus`。仅镜像旧插槽会漏掉置顶、重命名、分叉、归档等操作。

右上角菜单现在使用与会话列表右键菜单相同的服务、顺序、权限状态、图标和回调，
继续接入旧插槽扩展，并将原生“下载 Session 日志”和“反馈”放在底部。
旧版 DSH 继续使用插槽镜像。会话标题的重命名操作也接入新版菜单服务。

## Windows 终端

受管运行时中的 `conpty.dll` 文件存在，但完整路径超过 `node-pty` 原生加载器
使用的 `MAX_PATH` 缓冲区，产生 `Cannot find conpty.dll at , error code: 3`。

终端插件解析实际 subprocess provider 所使用的 `node-pty`，仅在 bundled ConPTY
明确报告路径不存在（错误码 2 或 3）时，用系统 ConPTY 重试一次。该错误发生于
分配 PTY 和启动 shell 之前。正常 DLL 路径、其他错误和非 Windows 平台沿用原行为；
不会修改或复制受管运行时文件。兼容模块已加入 Tauri 资源清单。

## 验证结果

- `npm run test:plugin`：763 项通过，0 项失败。
- `node tools/header-session-menu-smoke.mjs`：DSH 0.2.1-rc.2 和受管的
  0.2.2-rc.1 均通过。新版实际右键菜单与顶部菜单逐项对比一致；验证置顶状态、
  重命名、复制、会话切换、扩展项、禁用项和子菜单、键盘导航、明暗主题、窄屏、
  远程页面及原版外观切换。真实 DSH 页面中打开终端并执行命令成功。
- `node tools/conpty-smoke.mjs`：普通安装使用 bundled DLL 成功；受管长路径
  先复现 DLL 加载失败，再自动切换系统 ConPTY，完成真实 shell 输入、输出、
  调整大小及正常退出。
- `git diff --check`：通过。

所有 UI 检查使用隔离配置，不调用模型，不改变用户会话或运行时选择。
本次未生成新的安装包。
