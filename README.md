# Antigravity Quota & Token Widget

专为 **Google Antigravity 2.0 桌面版（Electron）** 打造的零依赖悬浮小插件：实时查看各模型剩余额度与重置倒计时，并直读本地对话数据库统计 Token 消耗。

## ✨ 核心特性

- **零依赖、纯本地运行**：无需安装第三方 npm 包或外部数据库驱动，直接复用 Antigravity 内置 Node 24 的 `node:sqlite` 与 Electron IPC。
- **上下文窗口占用率（Context Meter）**：
  - 自动解析当前对话最新一轮的真实上下文占用与模型上限（如 `320.5K / 512.0K (63%)`），并在右下角按钮实时显示 `上下文 xx%`；
  - 达到 75% 变黄、90% 变红，超过 80% 提示使用 `/compact` 压缩或新建对话。
- **实时模型额度 & 固定显示**：
  - 主进程直接调用本地 `language_server` 的 `RetrieveUserQuotaSummary` 接口，支持面板内一键刷新；
  - 默认在右下角悬浮按钮显示所有额度中的最低百分比；
  - **点击面板中任意一条额度项即可固定显示到右下角按钮**（如 `Gemini 周 78% · Token`、`Gemini 5h xx% · Token`），自动持久化保存，也可一键恢复「自动最低」。
- **任务完成 / 等待确认提醒**：
  - 轻量轮询本地任务状态，当长任务从运行中变为完成或等待用户确认时，自动播放 Web Audio 轻提示音并弹出桌面系统通知；
  - 面板顶栏内置 **`🔔提醒开 / 🔕提醒关`** 开关与 **`试听`** 按钮。
- **精准 Token 消耗统计、按日期筛选 & CSV 导出**：
  - 只读解析本地 `~/.gemini/antigravity/conversations/*.db`（含实时 WAL）中的 `gen_metadata` 与 `steps` 时间戳，以及 `conversation_summaries.db` 标题；
  - 展示**总计（输入 + 缓存读取 + 输出）**、**输入 / 输出 / 缓存读取 / 不含缓存**、**按模型分组**、**按对话前 5**；
  - 支持 **`今天` / `近7天` / `近30天` / `全部` / `自定义起止日期`** 实时筛选，以及一键 **`导出 CSV`**（UTF-8 BOM，Excel 直接打开不乱码）。
- **安全可逆、可与汉化包共存**：
  - 安装前校验候选 `app.asar` 与 JS 语法（`node --check`），仅向 `dist/main.js` 与 `dist/preload.js` 追加独立标记块；
  - 可与 [`qqxpee/antigravity2-cn`](https://github.com/qqxpee/antigravity2-cn) 汉化包共存，卸载时仅移除本插件代码块，不影响原有功能与汉化。

---

## 🚀 快速开始

### 1. 前置要求
- 已安装 **Node.js**（用于解包与重包 `app.asar`）
- 已安装 **Antigravity 2.0 桌面版**

### 2. 下载项目
```bash
git clone https://github.com/chendayuxixi/antigravity-quota-widget.git
cd antigravity-quota-widget
```

### 3. 一键安装（Windows）
1. **完全退出 Antigravity**（含右下角系统托盘后台进程）；
2. 双击运行 **`双击安装.bat`**（或在终端执行 `node install.js`）；
3. 重新打开 Antigravity，右下角即可看到 **`额度 & Token`** 悬浮按钮。

### 4. 一键卸载
完全退出 Antigravity 后，双击运行 **`双击卸载.bat`**（或执行 `node install.js --uninstall`）。

### 5. 命令行参数
```bash
# 安装（自动探测安装目录）
node install.js

# 手动指定 Antigravity 安装目录
node install.js --install-dir "C:\Users\你的用户名\AppData\Local\Programs\antigravity"

# 跳过自动关闭进程（适合脚本/测试场景）
node install.js --no-kill

# 卸载插件
node install.js --uninstall
```

---

## 📁 项目结构

- `src/token_stats_main.js`：主进程 IPC 处理器（只读解析本地对话 SQLite 数据库 + 查询本地 `language_server` 额度）
- `src/widget_preload.js`：渲染进程悬浮按钮、面板 UI、额度固定显示与日期筛选逻辑
- `src/asar_patcher.js`：零依赖纯 Node.js 二进制 ASAR 补丁器（基于 MIT 协议复用自 `qqxpee/antigravity2-cn`）
- `install.js`：跨平台安装 / 卸载脚本
- `双击安装.bat` / `双击卸载.bat`：Windows 一键脚本

---

## 🔒 隐私与安全说明

- 所有数据仅在你的本机读取与展示，**不向任何第三方服务器发送数据**；
- 额度查询仅请求本机回环地址（`127.0.0.1` / `localhost`）的 `language_server`；
- 本地日志仅记录摘要状态到 `%APPDATA%\Antigravity\ag-token-stats.log`（用于排查问题）。

---

## 📄 开源协议

本项目采用 [MIT License](LICENSE) 开源协议。ASAR 二进制补丁器 `src/asar_patcher.js` 基于 MIT 协议参考/复用自 [`qqxpee/antigravity2-cn`](https://github.com/qqxpee/antigravity2-cn)。
