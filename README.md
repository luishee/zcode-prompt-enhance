# ZCode 增强提示词

给 ZCode 的输入框加一个 **「✨ 增强提示词」** 按钮：点一下，把你随手写的草稿改写成更明确、更完整的提示词，直接回填到输入框；不满意可以一键还原原文。

交互参考 WorkBuddy 的「增强提示词」，并做了若干优化（失败不动草稿、还原可反复切换、模型跟随当前选择、双通道回退等）。

```
┌──────────────────────────────────────────────────────┐
│  帮我看看这段代码                                     │  ← 输入框
│                                                       │
│  ＋  DeepSeek-V4.1-Flash   ✨增强提示词  还原原文        │  ← 按钮长在这里（输入框下方工具栏）
└──────────────────────────────────────────────────────┘
```

> **平台**：Windows 10/11。实测环境 ZCode 3.17.2 + Python 3.15 + Node 24。
> 注入层需要改 ZCode 的 `app.asar`，每次 ZCode 升级后要重新注入一次（一条命令 / 双击 `.bat` 选 1）。

## 快速开始（3 步）

```powershell
# 0. 取代码（下面把仓库目录记作 <项目目录>）
git clone git@github.com:luishee/zcode-prompt-enhance.git
cd zcode-prompt-enhance
```

1. **装插件**：ZCode → 插件市场 → 添加插件市场 → 填 `<项目目录>\plugins` → 个人 → 安装「增强提示词服务」。
2. **注入按钮**：完全退出 ZCode（含托盘图标），双击 `修复增强提示词按钮.bat`，选 `1`。
3. **验证**：重新打开 ZCode，输入框下方出现 `✨增强提示词`。

之后每次 ZCode 升级，只需重复第 2 步。

---

## 目录

- [功能特性](#功能特性)
- [界面与交互](#界面与交互)
- [工作原理](#工作原理)
- [环境要求](#环境要求)
- [安装](#安装)
- [使用方式](#使用方式)
- [修复增强提示词按钮.bat 使用说明](#修复增强提示词按钮bat-使用说明)
- [命令参考](#命令参考)
- [ZCode 升级后怎么办](#zcode-升级后怎么办)
- [还原与卸载](#还原与卸载)
- [故障排查](#故障排查)
- [项目结构](#项目结构)
- [开发与测试](#开发与测试)
- [技术实现笔记](#技术实现笔记)
- [已知限制](#已知限制)

---

## 功能特性

| 能力 | 说明 |
| --- | --- |
| 一键增强 | 点按钮把草稿改写后**原样回填输入框**，不会自动发送消息 |
| 一键还原 | 增强成功后出现「还原原文」，还原后清空快照，可基于当前内容再次增强（可反复切换） |
| 快捷键 | `Ctrl+Shift+E` 增强；增强中再按一次或按 `Esc` 取消 |
| 跟随当前模型 | 优先抓 ZCode 真实请求体里的 `model`，其次读界面标签；服务端按 id → 显示名归一 |
| 失败不动草稿 | 网络异常、`success:false` 两条分支都**不覆盖**输入框，只在状态区提示原因 |
| 双通道回退 | 先走 ZCode 当前 provider（通道 A），失败自动切自配端点（通道 B），响应里说明实际通道 |
| 结果清洗 | 剥代码围栏、剥首尾引号、「增强后的提示词：」前缀；删除 ≤80 字的语言元信息行 |
| 超长提醒 | 增强结果超过 800 字给出提示（可再点一次让模型收敛），不静默截断 |
| UI 自愈 | ZCode 是 React + Lexical，工具栏被重渲染替换后自动补回按钮 |
| 诊断信标 | 按钮不显示时可定位到「脚本没加载 / 找不到输入框 / 锚点失配 / 写回失败」 |
| MCP 工具 | 插件同时暴露 `enhance_prompt`、`enhance_service_status`，可在 ZCode 对话里直接调用 |
| 本地 HTTP | `POST /api/enhance`、`GET /api/health`、`GET /api/models`、`POST /api/beacon` |

相比 WorkBuddy 原版的改动：

1. **失败绝不动草稿** —— 两条失败分支都不覆盖输入框；
2. **还原可反复切换** —— 还原后清空快照，可再次增强；
3. **服务端兜底清理元信息** —— 模型偶尔会输出「用户输入是中文 → 应回复中文」这类行，按「整行 ≤80 字」判定删除，不误伤长正文；
4. **双通道自动回退** —— ZCode 通道失败自动切到自配端点；
5. **超长提示** —— 超 800 字给出提示；
6. **编辑器重渲染自愈** —— 工具栏被替换后自动补回按钮；
7. **诊断信标** —— 按钮不出现时能从日志定位到具体卡在哪一步。

---

## 界面与交互

**位置**：输入框所在卡片的下方工具栏，紧跟在模型选择器后面。窄窗口（<760px）下自动隐藏文字只留图标，避免挤压布局。

**状态提示**（按钮右侧的小字，带 `title` 悬浮全文）：

| 状态文案 | 含义 |
| --- | --- |
| `增强中…` | 请求进行中，按钮变为旋转图标，再点一次可取消 |
| `已增强 · <模型>` | 成功并已写回编辑器 |
| `已增强 · <模型> · 通道 fallback` | 实际走的是通道 B（ZCode 通道不可用） |
| `已增强 · <模型> · 清理 N 行元信息` | 模型输出了语言标签行，服务端已删除 |
| `结果超过 800 字，可再点一次让模型收敛` | 黄色警告，不截断内容 |
| `请先输入需要增强的提示词` | 空草稿，未发起请求 |
| `已取消本次提示词增强` | 用户主动取消 |
| `已还原原文` | 还原成功 |
| `提示词增强失败：<原因>` | 失败，草稿原样保留 |
| `已生成增强结果，但写回输入框失败（编辑器结构可能已变）` | 已拿到结果但写不进编辑器，提示里带尝试过的策略 |

**失败原因分类**（服务端返回的 `code`）：

| code | 含义 | 处理 |
| --- | --- | --- |
| `empty_input` | 草稿为空 | 输入内容 |
| `upstream_unavailable` | 所有通道都连不上 / 没有可用通道 | 检查插件是否启用、provider 配置是否存在 |
| `llm_error` | 上游有响应但调用失败（如 401、模型不存在、返回空） | 看提示里的具体错误信息 |
| `unknown` | 其它（请求体不合法、内部异常） | 看 ZCode 插件日志 |

---

## 工作原理

这套东西由**两个互相独立**的部分组成，它们的"存活方式"完全不同：

```
① 注入层：把按钮画到输入框下方
   位置：ZCode 的 app.asar（渲染层）
   存活：每次 ZCode 升级都被覆盖  → 必须重新注入

② 服务层：按钮点下去时真正去调模型
   位置：ZCode 插件 enhance-service（MCP server + 本地 HTTP）
   存活：随 ZCode 启动 / 随 ZCode 退出  → 装好就不用再管
```

数据流：

```
ZCode 渲染层（file:// 加载 index.html）
  └─ assets/zcode-enhance.js       ← 补丁注入的脚本：按钮 + 读写编辑器 + 调本地服务
        │  fetch http://127.0.0.1:8770
        ▼
  plugins/enhance-service/（ZCode 插件，随 ZCode 启停）
        ├─ 通道 A「zcode」：读 ~/.zcode/v2/provider_config.json，用它正在用的 provider
        └─ 通道 B「fallback」：读插件目录 config.json，或环境变量自配端点
        两条通道依次尝试，谁先成功用谁（响应里带 channel 字段）
```

**为什么要拆成两层**：

- 注入层是为了「按钮长在输入框正下方」——ZCode 没开放这个位置，只能改包；
- 服务层是为了「进程能随 ZCode 启停」——注入的渲染层拿不到模型凭据，
  而 ZCode 的 `preload` 只暴露了远程连接/文件对话框等桥接，**没有模型调用能力**，
  所以必须有个进程持有凭据。

两层都替代不了对方：

| | 插件方案 | 注入方案 |
| --- | --- | --- |
| 能把按钮放进输入框下方 | ❌（插件 UI 只有 `availability: session` 侧栏面板） | ✅ |
| 进程随 ZCode 启停 | ✅ | ❌（改安装包不产生进程，也没法让 ZCode 拉起服务） |

所以**升级后你只需要做「重注入」这一件事，服务层不用管**。

### 为什么模型能「跟随 ZCode 当前选择」

渲染层读不到凭据，所以由服务读 ZCode 的 provider 配置（内含 baseUrl / apiKey / 模型列表），
这等价于「用 ZCode 当前在用的模型」。前端另外会把**真实请求体里的 model 抓出来**一并带上
（比读界面上的显示名更准），最终由服务统一归一成上游认识的模型 id（先按 id 匹配，再按显示名匹配）。

### 从 WorkBuddy 逆向到的真实契约（2026-11-09 实测）

来源：`WorkBuddy/resources/app.asar`（Electron 打包，未加密）。

| 环节 | WorkBuddy 的实际行为 | 本工具 |
| --- | --- | --- |
| RPC 名 | `llm:enhancePrompt` | `POST /api/enhance` |
| 入参 | `{text, model?, sessionId?}` | `{text, model?}` |
| 中断 | 错误标识 `enhance-prompt-aborted-by-user` | 前端 `AbortController` |
| 空输入 | 错误码 `empty_input` | 同 |
| 端点不可用 | 错误码 `sidecar_unavailable` | `upstream_unavailable` |
| 模型失败 | 错误码 `llm_error` | 同 |
| 结果清洗 | `stripWrappingQuotes`（剥首尾 `" ' “ ” ‘ ’`） | 同，另加围栏与标签处理 |
| 默认模型 | 不传则跟随会话当前模型 | 同（自动探测） |
| UI 文案 | `input.enhance.title` / `enhancing` / `revert` | 对齐 ZCode 自带 `chat.promptEnhance.*` |

**语言一致性是它的最高优先级约束**，并且专门给了坏例子
（`User input is in Chinese → Response must be in Chinese.` 这种把语言判定写进结果的错误）。
`plugins/enhance-service/prompts/enhance_user.txt` 原样保留这些约束与 few-shot。

---

## 环境要求

| 项 | 要求 | 用途 |
| --- | --- | --- |
| 操作系统 | Windows 10/11 | 注入 `app.asar`；`.bat` 维护入口 |
| ZCode 桌面版 | 实测 3.17.2 | 被注入的目标 |
| Python | 3.10+（实测 3.15） | `tools/*.py`、`.bat` 菜单 |
| Node.js | 18+（实测 24） | 插件里的 MCP server（由 ZCode 拉起） |
| 浏览器 | Chrome 或 Edge | 仅做 DOM 自测时需要 |

**不需要** `pip install` 或 `npm install`：所有脚本只用标准库。

ZCode 默认安装在 `D:\Program Files\ZCode`。装在别处时：

```powershell
# 方式一：环境变量（对 .bat 和所有脚本都生效）
$env:ZCODE_ASAR = "E:\Apps\ZCode\resources\app.asar"

# 方式二：命令行显式指定（注意 --asar 要写在子命令之前）
python "<项目目录>\tools\patch_zcode.py" --asar "E:\Apps\ZCode\resources\app.asar" apply
```

---

## 安装

### 第一步：安装服务插件（只需一次）

ZCode 官方流程规定插件必须走 UI 安装：

1. 打开 **插件市场 / Plugin Marketplace**；
2. **添加 → 添加插件市场**，粘贴市场根目录（把 `<项目目录>` 换成实际路径）：

   ```
   <项目目录>\plugins
   ```

3. 打开 **个人**，找到 **增强提示词服务**，点 **安装**；
4. 到 **设置 → 插件** 确认它是启用状态。

装好后，服务进程由 ZCode 自己拉起、退出时自己回收——**不需要手动起任何服务，重启电脑也不会失效**。

验证（ZCode 正在运行时）：

```powershell
# 1. 有没有 MCP server 子进程
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*mcp-server.mjs*' } |
  Select-Object ProcessId, CommandLine

# 2. 端口是否在服务，通道是否读到
Invoke-RestMethod http://127.0.0.1:8770/api/health
```

`/api/health` 返回 `ok:true`、`version`、`channels`（含 `hasKey` 与模型列表）就说明服务层就绪。

生命周期实测（2026-11-10）：

| 情形 | 结果 |
| --- | --- |
| ZCode 启动 | 自动拉起 `node .../scripts/mcp-server.mjs`，并占用 `127.0.0.1:8770` |
| 祖先链 | `node → ZCode.exe(插件宿主) → ZCode.exe(utility) → ZCode.exe(主进程) → explorer.exe`，顶端是 ZCode |
| 关闭 ZCode 后 | 上面那条 `Get-CimInstance` 查询**无任何输出** → 不留孤儿进程 |
| 重新打开 | 自动重新拉起（新 pid），`/api/health` 上报版本与安装目录一致 |

### 第二步：注入按钮（需先完全退出 ZCode）

**推荐：双击 `修复增强提示词按钮.bat`，选 `1`。** 它会自己判断 ZCode 是否在运行，并告诉你下一步该「重启」还是「直接打开」。

等价的命令行方式：

```powershell
python "<项目目录>\tools\patch_zcode.py" apply
```

然后重新打开 ZCode，输入框下方就能看到按钮。

写入行为（`apply` 的约定）：

- **幂等**：已注入则跳过写入；
- **写完即自检**：只允许 `index.html` 变化 + 新增注入脚本，逐字节比对约 3.18 万个文件；
- **校验不过自动回滚**：就地还原并返回非 0 退出码，绝不留一个启动不了的半成品；
- **写入双保险**：优先原子替换，`Program Files` 下遇到 `PermissionError` 自动回落为就地覆写；
- **备份放安装目录之外**：`%LOCALAPPDATA%\zcode-prompt-enhance\backups\app.asar.<版本>.<哈希>.orig`，
  并自动只保留当前基线 + 最近 1 份（每份约 374MB）。放在 `resources/` 里会被升级安装器一起删掉。

### 第三步：验证

1. 打开 ZCode，输入框下方出现 `✨增强提示词`；
2. 输入几句话，点按钮，内容被改写并回填；
3. 不放心就用 `.bat` 选 `3` 读诊断信标，看到 `✓ 脚本已加载，按钮已挂到输入框工具栏上` 即成功。

---

## 使用方式

### 基本流程

1. 在输入框写下草稿（一句话也行，比如「帮我看看这段代码」）；
2. 点 `✨增强提示词`（或按 `Ctrl+Shift+E`）；
3. 等 2～4 秒，草稿被改写后的完整提示词替换，状态显示 `已增强 · <模型>`；
4. 满意就直接发送；不满意点 `还原原文` 回到原草稿，或再点一次增强让模型重写。

### 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+Shift+E` | 增强当前草稿 |
| `Ctrl+Shift+E`（增强中） | 取消本次增强 |
| `Esc`（增强中） | 取消本次增强 |

### 让 ZCode 直接调用插件工具

插件暴露两个 MCP 工具，可以在对话里直接用自然语言要求调用：

| 工具 | 作用 |
| --- | --- |
| `enhance_prompt` | 入参 `{text, model?}`，与按钮同一套逻辑与提示词，返回 JSON（含 `model` / `channel` / `elapsedMs`） |
| `enhance_service_status` | 返回端口、监听状态、版本、prompt 目录与各通道信息 |

例如：「用 `enhance_prompt` 帮我改写这句话：把这段代码改好」。

### 本地 HTTP 接口

注入的按钮就是调这些接口；也可以自己用 PowerShell 调：

```powershell
# 健康检查：pid、版本、通道、模型
Invoke-RestMethod http://127.0.0.1:8770/api/health

# 可用模型列表（走通道 A 的 /models，取不到时回落到配置里的模型）
Invoke-RestMethod http://127.0.0.1:8770/api/models

# 增强
Invoke-RestMethod -Uri http://127.0.0.1:8770/api/enhance -Method Post `
  -ContentType 'application/json' `
  -Body '{"text":"帮我看看这段代码"}'
```

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/health` | GET | 服务与通道状态 |
| `/api/models` | GET | 模型列表（`source: upstream` 表示真的从上游取到了） |
| `/api/enhance` | POST | `{text, model?}` → `{success, text, model, channel, elapsedMs, removedMetaLines, overLength}` |
| `/api/beacon` | POST | 注入脚本上报诊断信标（写 `%LOCALAPPDATA%\zcode-prompt-enhance\beacon.log`） |

上游调用参数：`temperature: 0.3`（改写任务要稳）、`max_tokens: 1200`、超时 60 秒。

### 通道 B：自配端点（可选）

通道 A 读不到 ZCode 配置、或你想换端点时，在 `plugins/enhance-service/` 下建 `config.json`：

```json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-xxx",
  "model": "deepseek-chat"
}
```

也可以用环境变量（配进 ZCode 进程所在环境）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PROMPT_ENHANCER_BASE_URL` | 空 | 通道 B 的 baseUrl（OpenAI 兼容） |
| `PROMPT_ENHANCER_API_KEY` | 空 | 通道 B 的 key |
| `PROMPT_ENHANCER_MODEL` | 空 | 通道 B 默认模型 |
| `PROMPT_ENHANCER_PREFER` | `zcode` | 通道优先级：`zcode` 或 `fallback` |
| `PROMPT_ENHANCER_PORT` | `8770` | 服务端口（改了之后要 `restore` 再用 `--endpoint http://127.0.0.1:<新端口>` 重新 `apply`） |
| `PROMPT_ENHANCER_ZCODE_CONFIG` | `~/.zcode/v2/provider_config.json` | 通道 A 的配置路径（测试用） |
| `PROMPT_ENHANCER_BEACON_LOG` | `%LOCALAPPDATA%\zcode-prompt-enhance\beacon.log` | 信标落盘路径 |

> `.env.example` 只是变量名参考，**不会被自动加载**——插件由 ZCode 直接拉起，不经过 shell。

---

## `修复增强提示词按钮.bat` 使用说明

### 它是什么

根目录下的 `修复增强提示词按钮.bat` 是**维护入口**（不是启动器，也不需要常驻）：

- 注入 / 重注入按钮；
- 查看注入状态；
- 检查按钮是否真的挂上了（读诊断信标）；
- 还原到注入前的原始 `app.asar`。

它自身只有十几行 ASCII，真正的菜单与文案在 `tools/menu.py`（原因见文末「为什么 `.bat` 这么薄」）。
`.bat` 用 `cd /d "%~dp0"` 定位自身目录，所以**放在哪、从哪里双击都能跑，不需要先 `cd`**。

### 双击使用（交互模式）

双击后出现菜单：

```
============================================================
   ZCode 增强提示词 · 维护
============================================================

   1  升级后重新注入按钮      （ZCode 升级后跑这个）
   2  查看注入状态
   3  检查按钮是否已挂上      （ZCode 需正在运行）
   4  还原 / 彻底移除注入
   0  退出
```

直接回车 = 选 `1`。做完一项后会停在「按回车返回菜单」，可以连着做几件事。

| 选项 | 做什么 | 前置条件 | 输出怎么读 |
| --- | --- | --- | --- |
| `1` | 先检测 ZCode 是否在运行，再执行 `patch_zcode.py apply` | **完全退出 ZCode**（含托盘图标），否则写入可能被占用 | 成功时明确告诉你「重启 ZCode」还是「直接打开」；失败时列出三种常见原因 |
| `2` | 执行 `patch_zcode.py status` | 无 | 显示 asar 路径、大小、JSON 区余量、`已打补丁` / `原始`、备份位置与补丁时间 |
| `3` | 执行 `check_beacon.py --wait 30`，最多等 30 秒 | **ZCode 正在运行**，且刚打开过输入框 | 看到 `✓ 脚本已加载，按钮已挂到输入框工具栏上` 即正常；否则会指出卡在哪一步 |
| `4` | 确认后执行 `patch_zcode.py restore` | 存在基线备份（`status` 里 `存在=True`） | 会先要求输入 `y` 确认；还原后需重启 ZCode |
| `0` | 退出 | — | — |

选 `1` 时如果 ZCode 还在运行，它**不会**替你杀进程，只会提示「必须完全退出 ZCode 再重新打开才会生效（托盘图标也要退出）」。

### 命令行使用（非交互 / 接自动化）

```bat
修复增强提示词按钮.bat apply      :: 重新注入
修复增强提示词按钮.bat status     :: 查看状态
修复增强提示词按钮.bat check      :: 读信标检查按钮
修复增强提示词按钮.bat restore    :: 还原（仍会要求输入 y）
```

- 参数会原样传给 `tools/menu.py`，等价于 `python tools/menu.py apply`；
- **退出码**：`0` 成功；`1` 执行失败（如权限被拒、找不到备份）；`2` 参数不认识；
- 只有**失败时**窗口才会 `pause` 停住（方便看报错），成功时执行完直接关闭——适合放进脚本/任务计划；
- 还原若要全自动，用 `echo y | 修复增强提示词按钮.bat restore`；
- 带空格或中文的路径直接用引号包起来即可。

### 注意事项

| 事项 | 说明 |
| --- | --- |
| Python 必须在 `PATH` | `.bat` 调用的是 `python`。提示 `'python' 不是内部或外部命令` 就是没装或没加进 PATH |
| 一般不需要管理员权限 | 只有 `apply` 报「权限被拒 / `PermissionError`」时，右键 **以管理员身份运行** |
| 不要只关窗口不关 ZCode | 补丁在 ZCode 启动时加载，必须把 ZCode **完全退出**（托盘也要退）再启动 |
| 运行日志 | 菜单输出在控制台；诊断信标在 `%LOCALAPPDATA%\zcode-prompt-enhance\beacon.log` |
| 不要重复起服务 | `8770` 由插件占用，起第二个实例只会抢端口、让"谁在服务"更难判断 |

### 为什么 `.bat` 这么薄

实测（2026-11-10）：cmd.exe 按固定大小缓冲分块读取批处理文件，UTF-8 汉字一旦跨过缓冲边界就被截断，
同一行中文 `echo …` **有时正常、有时被当成命令执行**并报「不是内部或外部命令」——间歇性、不可预测。
把中文界面交给 Python（配合 `.bat` 里的 `chcp 65001`）后完全稳定，所以 `.bat` 只保留 ASCII 的转发逻辑。

---

## 命令参考

| 命令 | 用途 |
| --- | --- |
| `python tools/patch_zcode.py apply` | 注入（**幂等**：已注入会跳过）；升级后跑这条 |
| `python tools/patch_zcode.py status` | 查看注入状态与备份位置 |
| `python tools/patch_zcode.py restore` | 回滚到基线备份 |
| `python tools/patch_zcode.py verify` | 读回校验 + 抽样比对 |
| `python tools/patch_zcode.py --dry-run apply` | 演练：写到 `<asar>.dryrun`，不动原文件、不写状态 |
| `python tools/verify_patch.py --original <备份> --patched <asar>` | 全量逐字节校验（实测约 3.18 万文件） |
| `python tools/check_beacon.py [--wait 30]` | 按钮没出现时，读信标定位卡在哪一步 |
| `python tools/run_dom_test.py` | 无头浏览器跑注入脚本的 23 项 DOM 断言 |
| `node tests/test_mcp_server.mjs` | 插件服务测试（43 项，含生命周期与端口冲突） |
| `python tools/menu.py [apply\|status\|check\|restore]` | `.bat` 的实际实现，也可直接调 |

所有脚本都按**自身位置**定位项目和默认路径，不依赖当前工作目录。

---

## ZCode 升级后怎么办

ZCode 升级会用安装器替换 `resources/`，**只有注入层会失效**（服务层由插件机制管，不受影响）。

现象：按钮消失，`status` 显示 `原始`。修复：**重注入 + 重启 ZCode**。

### 方式一：双击 `.bat`（最省事）

双击 `修复增强提示词按钮.bat` → 选 `1` → 按提示重启 ZCode。

### 方式二：一条命令

```powershell
python "<项目目录>\tools\patch_zcode.py" apply
```

### 方式三：ZCode 自带的「自动化」（推荐固化成任务）

在 ZCode 里打开本项目，新建一个自动化任务（`自动化` 页面 → `新建`），先设为**暂停**，需要时点「立即运行」：

| 字段 | 值 |
| --- | --- |
| 项目 | `zcode-prompt-enhance` |
| 任务标题 | `升级后重注入增强提示词按钮` |
| 调度 | 任选（建好后暂停，它就不会自动跑） |
| 指令 | 见下方 |

指令内容（直接复制）：

```
ZCode 升级会用安装器替换 resources/，导致注入的「增强提示词」按钮消失。请在本项目内完成重新注入：

1. 运行 python tools/patch_zcode.py status，判断当前是「已打补丁」还是「原始」。
2. 若为「原始」，运行 python tools/patch_zcode.py apply 重新注入（幂等；会自动建基线备份、写完自检，校验不过会自己回滚并返回非 0）。
3. 校验未通过或状态异常时，用 python tools/verify_patch.py --original <备份> --patched "D:\Program Files\ZCode\resources\app.asar" 做全量逐字节比对，要求「非预期差异 0」；仍不过就运行 python tools/patch_zcode.py restore 回滚并报告原因。
4. 完成后提醒我：完全退出并重开 ZCode。服务层是插件，不用管。
5. 顺带确认官方是否已自带该功能：若渲染层已出现 chat.promptEnhance 的实现代码（不只是文案），提示我可以执行 restore 退役注入层。
```

> `CronUpdate` 不能修改启用状态，所以「暂停」这一步需要在 UI 点一下。

### 如果 `apply` 说「已打过补丁」但按钮还是没有

说明 asar 里残留了脚本标签（例如上次写入后 ZCode 覆盖了一半，或升级包版本号相同）。
先还原再注入：

```powershell
python "<项目目录>\tools\patch_zcode.py" restore
python "<项目目录>\tools\patch_zcode.py" apply
```

然后完全重启 ZCode。

---

## 还原与卸载

**只去掉按钮，保留插件服务：**

```powershell
python "<项目目录>\tools\patch_zcode.py" restore
```

或双击 `.bat` 选 `4`（会要求输入 `y` 确认）。还原后完全重启 ZCode，按钮消失。

**彻底卸载：**

1. 上一步 `restore`；
2. ZCode → 设置 → 插件 → 卸载「增强提示词服务」；
3. ZCode → 插件市场 → 移除本地市场（可选）；
4. 删除数据目录（可选，含备份与信标日志）：

   ```powershell
   Remove-Item -Recurse -Force "$env:LOCALAPPDATA\zcode-prompt-enhance"
   ```

5. 删除本仓库目录。

若官方某天自带了原生按钮，确认后直接 `restore` 退役注入层即可（`apply` 期间会自动探测
`chat.promptEnhance.*` 是否已被官方代码引用并给出提示）。

---

## 故障排查

### 按钮不出现

按顺序查，不要跳步：

| 步骤 | 命令 | 判断 |
| --- | --- | --- |
| 1. 补丁在不在 | `python tools/patch_zcode.py status` | `原始` → 重注入；`已打补丁` → 下一步 |
| 2. ZCode 是否真的重启了 | 托盘图标是否也退出过 | 没重启 → 补丁不会被加载 |
| 3. 脚本是否执行 | `python tools/check_beacon.py --wait 30` | 没有 `boot` → 脚本没加载（回到第 1 步） |
| 4. 是否找到输入框 | 同上，看 `boot` 的 `composers` | `composers=0` 且无 `composer-seen` → 选择器过期，需更新 `SEL.composer` |
| 5. 锚点是否命中 | 同上，看 `attach-failed` | `hasActions=false` → DOM 结构变了，更新 `SEL.actions` / `SEL.editor` |

信标含义（写在 `%LOCALAPPDATA%\zcode-prompt-enhance\beacon.log`）：

| 信标 | 含义 |
| --- | --- |
| `boot` | 脚本已加载，附 `composers`（此时页面上找到的 composer 数量） |
| `composer-seen` | 找到了 composer，附 `hasActions` / `hasEditor` / `hasModelLabel` |
| `attached` | 按钮已挂上，附挂载点 class |
| `attach-failed` | 找到了 composer 但锚点失配 |
| `write-ok` / `write-failed` | 写回编辑器的结果，失败时附尝试过的策略与长度 |

### 按钮在，但点了报错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `提示词增强失败：Failed to fetch · 增强服务未响应…` | 插件没跑 / 端口没监听 | 查 `mcp-server.mjs` 进程与 `/api/health`；确认插件已启用；重启 ZCode |
| `upstream_unavailable` | 通道 A 读不到配置且没有通道 B | 配 `plugins/enhance-service/config.json` 或检查 `~/.zcode/v2/provider_config.json` |
| `llm_error` + HTTP 401/403 | key 失效 | 在 ZCode 里重新登录/配置 provider，或改用通道 B |
| `llm_error` + 模型不存在 | 模型名没归一上 | 响应里带 `model`，检查该上游是否真的提供这个 id |
| `写回输入框失败` | 编辑器结构变了 | 看信标 `write-failed` 的 `hasApi`：`false` 说明 `editorApiRef` 找不到了，需要更新 `findEditorApi` |

### `apply` 失败

| 提示 | 原因 | 处理 |
| --- | --- | --- |
| `不是可识别的 asar 包` | ZCode 改了打包格式 | 未改动任何字节；需改用「完整解包 → 注入 → 重打包」 |
| `JSON 区放不下` | 新版本头部空间不足 | 需人工处理（扩大头部或换方案） |
| `PermissionError` / 权限被拒 | 文件被占用或无写权限 | 完全退出 ZCode；仍失败则右键 `.bat` → 以管理员身份运行 |

### 其它已知坑

| 坑 | 现象 | 处理 |
| --- | --- | --- |
| 更新插件后旧进程没退 | 端口上跑的还是旧版本，新版本绑不上 `8770` | **完全退出 ZCode 再启动**（卸载不会杀已在运行的旧进程） |
| 端口被占 | 日志刷「端口 8770 被占用，N 秒后重试」 | 关掉占用进程；或改 `PROMPT_ENHANCER_PORT`，`restore` 后用 `--endpoint http://127.0.0.1:<新端口>` 重新 `apply` |
| 编辑器只读 | 生成回复过程中写不进去 | 等生成结束再点 |
| 控制台中文乱码 | Windows 代码页是 GBK | 脚本已自行 `reconfigure(utf-8)`；`.bat` 里有 `chcp 65001` |

---

## 项目结构

```
zcode-prompt-enhance/
├─ plugins/                        ← 本地市场（给 ZCode 插件市场添加的目录）
│   ├─ marketplace.json            市场清单
│   └─ enhance-service/
│       ├─ .zcode-plugin/plugin.json
│       ├─ .mcp.json               MCP server 声明（stdio）
│       ├─ prompts/                提示词（唯一源；插件自包含，安装后原项目路径不可用）
│       └─ scripts/mcp-server.mjs  MCP stdio + HTTP 8770 双职责
├─ inject/zcode-enhance.js         注入到渲染层的脚本（按钮本体）
├─ tools/
│   ├─ asar_reader.py              asar 读取
│   ├─ patch_zcode.py              打补丁 / 还原 / 查看状态
│   ├─ verify_patch.py             全量逐字节校验
│   ├─ check_beacon.py             读信标定位按钮不出现的原因
│   ├─ run_dom_test.py             无头浏览器 DOM 自测
│   └─ menu.py                     维护菜单（.bat 的实际内容）
├─ tests/test_mcp_server.mjs       插件服务测试（43 项，含生命周期与端口冲突）
├─ web/                            本地预览页 + DOM 自测用页面
├─ 修复增强提示词按钮.bat          维护入口（双击运行：注入/状态/检查/还原）
├─ .env.example                    通道 B 环境变量参考（不会被自动加载）
└─ patch-state.json                本机注入状态（已 gitignore，含绝对路径与哈希）
```

---

## 开发与测试

```powershell
# 插件服务测试：MCP 握手、tools/call、HTTP、端口冲突、stdin 关闭即退出（43 项）
node tests/test_mcp_server.mjs

# 注入脚本 DOM 自测：按钮位置、type=button、空输入、写回、还原、失败保草稿、
# 官方 API 优先、写回全失败的信标（23 项，需要 Chrome/Edge）
python tools/run_dom_test.py

# 全量逐字节校验（需先拿到原始备份）
python tools/verify_patch.py --original "<备份>" --patched "D:\Program Files\ZCode\resources\app.asar"
```

`web/mock_composer.html` 是仿 composer 结构的本地预览页，可直接用浏览器打开看按钮样式；
`web/mock-selftest.js` 里的断言由 `run_dom_test.py` 在无头浏览器里执行。

改完 `inject/zcode-enhance.js` 或 `prompts/` 后：

- 注入脚本：重新 `apply` 前先 `restore`（`apply` 是幂等的，会跳过已注入的包）；
- 提示词：插件从自身目录读 `prompts/`，改完需要重装插件或直接改已安装副本，然后**重启 ZCode**。

---

## 技术实现笔记

### 为什么不用「解包再重打包」

ZCode 的插件机制只开放 `availability: "session"` 的侧栏面板，**没有输入框注入点**；
且 `promptEnhance` 在它的包里只有 i18n 文案，没有实现代码。所以只能改 `app.asar`。

但「解包 374MB 再重打包」风险很高（重写全部数据区、要正确处理 unpacked 文件，出错就起不来）。
这里改用**保持头部 JSON 区长度不变**的做法：

1. 实测头部布局：`data_start = 16 + P`，`prefix[4:8] = P + 8`，`prefix[12:16] = 真实 JSON 长度`，`P = ceil(L/4)*4`；
2. **把 P 保持不变** → `data_start` 不变 → 所有已有文件偏移继续有效；
3. 只需在固定长度的 JSON 区里写入新 JSON（不足补 0），并把新文件追加到文件末尾登记偏移；
4. JSON 区只剩几字节余量，所以删掉若干文件的 `integrity` 字段腾地方——
   ZCode 的 `EnableEmbeddedAsarIntegrityValidation` fuse 是 Disabled（实测），该字段不参与校验。

补丁以「新增一个文件 + 改一行 script 标签」为全部改动，其余字节原样复制。
注入脚本必须放在 `assets/` 下：渲染层自定义协议只把 `/assets/*` 映射到 `rendererDir/assets/*`，
放根目录会被路由成 404，按钮根本不出现。

### 坑一：HTTP 不能阻塞 MCP 握手

插件首次安装后表现为「装好了、也启用了，但没有任何 node 进程」——因为早先写成 `await startHttp()`，
而端口被占时是无限重试，于是 `startHttp` 永远不返回 → stdio 循环没建立 → 宿主的 `initialize`
收不到回复 → 插件被判 failed 并杀掉进程。

修法：`startHttp()` 只发不 await，MCP stdio 立刻建立；HTTP 在后台自己重试（前 15 次每 20s，
之后每 5 分钟一次）。测试里对应「端口被占时 MCP 仍能应答 initialize」这一项。

排查判据：**插件启用后若看不到 `node.exe ... mcp-server.mjs` 进程，就是 MCP 握手没成功**，
去 ZCode 日志里找 `initialize` 相关错误，别先怀疑端口或凭据。

### 坑二：更新插件后必须重启 ZCode

实测（2026-11-10）：卸载重装插件时，ZCode 会删除旧版本目录，但**不会终止已经在运行的旧进程**。
结果是旧进程仍占着 `8770`、health 仍上报旧版本号，新版本绑不上端口，只能重试。

**结论：更新插件后必须完全退出 ZCode 再启动**，旧的 MCP server 才会随宿主回收、新版本才能接管。

### 坑三：判断代码是否存在某写法，不能用子串匹配

排查坑二时曾断言「新副本里是旧代码」，依据是 `'await startHttp()' in source` 为真——
但那个字符串**恰好出现在注释里**，实际语句早已改成 `startHttp().catch(...)`。

**教训**：判断"某写法是否还在生效"必须满足其一：剥掉注释与字符串后再匹配；匹配带上下文的模式；
或直接跑行为测试（本例的「端口被占时 MCP 仍能应答 initialize」就是行为级验证）。
同理，断言「UI 会反复提示更新」也曾误判——判定是 `installed.version === marketplace.version → synced`，
是改过缓存副本的版本号造成的假象。**先读判定逻辑再下结论。**

### 实测数据（2026-11-10，ZCode 3.17.2）

| 项 | 结果 |
| --- | --- |
| 补丁后 asar 增量 | 约 +47KB（其余字节原样复制） |
| 全量校验 | 比对约 3.18 万个文件，**非预期差异 0** |
| 第三方解析 | npm `asar list` 能正常解析补丁后的包 |
| 增强耗时 | 中文 2.3s / 英文 2.6s / 混排 3.8s（deepseek-flash，本机网关） |
| 语言一致性 | 中文→中文、英文→英文、混排→自然混排，均无语言标签混入 |
| DOM 自测 | 23 项断言全过（无头 Edge） |
| 服务端测试 | 43 项全过 |

---

## 已知限制

- **仅 Windows**：依赖 Windows 路径、`Program Files` 权限模型与 `.bat` 入口；其它平台需自行改造。
- **每次 ZCode 升级后需要重新注入**（`app.asar` 会被覆盖）。升级后 `apply` 即可（幂等）。
- **依赖 ZCode 的 DOM 结构与内部 API**：选择器（`data-composer-layout` 等）或
  `editorApiRef` 一旦变化，需要同步更新 `inject/zcode-enhance.js`；写回失败会明确提示而不是假装成功。
- **更新插件后必须重启 ZCode**（旧 MCP server 不会随卸载退出）。
- **`127.0.0.1:8770` 只能有一个实例**：由插件占用，不要再起第二个服务（不随 ZCode 启停、还会抢端口）。
- **输入框必须可编辑**：正在生成回复等只读状态下不保证能写回。
- **修改第三方安装包有风险**：本工具只做最小改动并自动校验/回滚，但仍建议先备份、
  明确知道自己在做什么再动手；因使用本工具造成的任何问题请自行承担。
- **渲染层拿不到模型凭据**，也没有可复用的模型调用桥，所以"点按钮 → 调模型"必须经过插件进程，无法做成纯前端。

---

## English

**ZCode Prompt Enhance** adds a `✨ Enhance prompt` button under the composer of the ZCode desktop app.
Click it and your draft is rewritten into a clearer, more complete prompt and written back in place,
with one-click revert. It follows the model currently selected in ZCode, falls back to a
self-configured endpoint when needed, and never overwrites your draft on failure.

Two layers: (1) a patched renderer script (`inject/zcode-enhance.js`, injected into `app.asar`,
must be re-applied after each ZCode upgrade), and (2) a ZCode plugin (`plugins/enhance-service`,
an MCP server that also serves `127.0.0.1:8770`) started and stopped with ZCode.

Windows only. Python 3.10+ and Node 18+ required, no third-party packages.
See the sections above for install steps, usage, and the `.bat` maintenance entry
(`修复增强提示词按钮.bat`, also callable as `修复增强提示词按钮.bat apply|status|check|restore`).
