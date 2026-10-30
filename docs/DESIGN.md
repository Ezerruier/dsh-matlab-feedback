# dsh-matlab-feedback 设计说明

> 本文件描述插件的实现原理、契约与关键取舍，供二次开发与审阅使用。
> 文中路径均为示意：`<workspace>` 表示当前 Harness 会话工作目录，`<repo>` 表示本仓库根目录。

## 1. 目标

用户在本机 Windows 上用 MATLAB + DPABI/DPARSF/SPM 做 fMRI 预处理时，经常需要针对屏幕上的 QC 图形窗口（配准、分割、阈值、归一化等）向 Agent 提问。手工截图再上传效率低，且命令行窗口里的 SPM/DPARSF 日志与报错往往才是关键信息。

本插件让 Agent 可以用一次工具调用取到：

1. 各 MATLAB 窗口的**真实截图**（像素级，含 OpenGL 渲染的脑图与 uicontrol 控件）；
2. **命令行窗口文本**（SPM job 日志、DPARSF 进度、警告、报错、parpool 信息）；
3. 窗口内**控件文本与选中值**（例如 QC Score 当前选中项）；
4. warnings 摘要。

约束：只读、零侵入、无第三方依赖、不改 MATLAB 配置。

## 2. 为什么是 Windows UI Automation + PrintWindow

MATLAB R2025a 起桌面改为 CEF/Chromium 渲染（窗口类名 `WindowClass`），带来两个可利用的事实：

- **UIA TextPattern** 可读出窗口内完整文本（含中文），命令行窗口在 AutomationId 为 `commandWindowWrapper` 的 Group 子树下；
- **`PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT=2)`** 能完整截取 CEF 窗口（含 GPU/OpenGL 内容），无需把窗口切到前台。

因此不需要 MATLAB Engine、不需要在 MATLAB 里运行桥接脚本、不需要官方 MATLAB MCP；MATLAB 正忙（parpool 计算中）时也能捕获。

## 3. 捕获流程

`<repo>/scripts/matlab-feedback.ps1`：

1. 枚举 `MATLAB` 进程的所有顶层窗口（`EnumWindows` + 进程过滤），筛选 `WindowClass`、可见、标题非空，排除 IME/工具提示等系统窗口；
2. 按标题分类角色：`desktop`（`MATLAB R20xx`）、`qc-figure`（SPM Graphics）、`pipeline-gui`（DPARSF/DPABI）、`figure`、`other`；
3. 非最小化窗口：`GetWindowRect` + `PrintWindow` → PNG（8-bit）；
4. 逐窗口尝试 UIA：`Document` 的 TextPattern 取整窗文本；对命令行窗口子树按先序收集 `Text` 节点拼出命令行文本；对单选控件额外读取 `SelectionItemPattern` 的选中态；
5. 从文本中提取警告/错误行；
6. 输出 UTF-8 无 BOM 的 `manifest.json` 与 PNG。

降级策略：

- UIA 不可用（老版 MATLAB / 无桌面）→ 仍出窗口清单与截图，`text` 为空、`textSource: "none"`；
- 单窗口截图失败 → 该窗口 `screenshot: null`，不影响整次捕获；
- 无 MATLAB 进程 → 退出码 2（Host 转为可读错误）；
- 脚本对窗口/焦点/输入 **只读**（静态审计无 `SetForegroundWindow`/`SendInput`/`ShowWindow` 等 API）。

## 4. `manifest.json` 契约（schemaVersion = 1）

```json
{
  "schemaVersion": 1,
  "capturedAt": "2026-10-30T00:00:00.000+08:00",
  "durationMs": 800,
  "matlabProcesses": [{"pid": 4242, "commandLine": "..."}],
  "windows": [
    {
      "id": "w1",
      "title": "SPM26 (00.00): Graphics",
      "role": "qc-figure",
      "hwnd": "1001",
      "pid": 4242,
      "visible": true,
      "minimized": false,
      "rect": {"x": 0, "y": 0, "width": 703, "height": 1051},
      "screenshot": {"file": "w1-SPM_Graphics.png", "bytes": 91733, "width": 703, "height": 1051},
      "text": "…",
      "textSource": "uia-document",
      "textTruncated": false
    }
  ],
  "console": {
    "windowId": "w3",
    "title": "MATLAB R2026a",
    "text": "…",
    "textSource": "uia-commandwindow",
    "truncated": false
  },
  "warnings": ["警告: …"]
}
```

字段语义：

- `role`：`desktop | qc-figure | pipeline-gui | figure | other`；
- `screenshot`：可为 `null`；`file` 是相对 `OutDir` 的安全文件名；
- `textSource`：`uia-document | uia-commandwindow | none`；
- `console.windowId`：承载命令行窗口的主窗口 id，可为 `null`。

## 5. Host 半侧（`index.mjs`）

- `apply(ctx)` + `inject: ['tools']`；`attachments` / `systemPrompt` / `workingDirectory` 通过 `ctx.get()` 可选获取，缺失时自动降级；
- 每次调用在 `<workspace>/.dsh-matlab-feedback/<runId>/` 新建目录（最多保留 20 个），spawn
  `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <capture.ps1> -OutDir <run> -Mode all|console`；
- 30 秒超时；`exec.signal` 中止时 kill 子进程；退出码 2 映射为“没有运行中的 MATLAB 会话”的可读错误；
- 截图经 `attachments.saveImage({data, mediaType: 'image/png', name})` 持久化为附件，再以
  `{type: 'image', attachment: {attachmentId, mediaType, bytes, width, height, name}}` 内容块内嵌到工具结果；
- 图片选取优先级：`qc-figure > pipeline-gui > figure > desktop`，最多 4 张；
- 命令行文本默认返回尾部 6000 字符（`matlab_console` 按行数），超出注明截断并给出完整 manifest 路径；
- 无 attachments 服务时只返回文本 + PNG 绝对路径，提示用 `read_image` 兜底。

工具结果值（供 `output.render` 使用）主要字段：

```text
kind, mode, capturedAt, durationMs, runId, outDir, fullManifestPath,
matlabProcesses, windows[{id,title,role,width,height,minimized,screenshotPath,textPreview,textSource}],
consoleText, consoleTruncated, warnings, images[{title,path,attachment}], attachmentsAvailable
```

## 6. Client 半侧（`client.js`）

- 浏览器模块：`window.__ModuleLoader__.load({id: 'dsh-matlab-feedback', factory(require){…}})`，仅 `require('react')`；
- 在 `conversation.input.left`（list slot）注册按钮 `matlab-feedback-capture`（order 20）；
- 点击：`const span = props.inputActions.captureInsertion(); props.inputActions.insertText(t('insert.prompt'), span)`——
  把预置提示词插入草稿，**不自动发送**；`insertText` 返回 false 时静默（草稿已变化或正在提交）；
- 语言包通过 `ctx.locale.register('matlabFeedback', {zh, en})` 注册，按钮文案贴合当前语言；
- 样式只使用 `--dsw-alias-*` 主题 token（`label-primary`、`border-l2`、`interactive-bg-hover`、`brand-primary`），自动适配明暗主题；无 DOM 副作用。

## 7. 测试策略

- `tests/host/unit.test.mjs` + `fixture.mjs` + `fake-host.mjs`：fixture 驱动的纯 Node 单测（27 条），不启动 PowerShell、不接触 MATLAB；覆盖参数拼装、manifest 归一化与降级、图片优先级、文本渲染、超时/退出码/spawn 失败、run 目录清理、附件缺失降级；
- `tests/host/dry-run.mjs`：用 fake DSH context + 真实捕获脚本跑完整 execute/render 流程（需要 MATLAB 打开），只读；
- `tests/capture/smoke-test.ps1`：对当前 MATLAB 做一次真实捕获并校验 manifest schema、窗口数、PNG 尺寸；无 MATLAB 时以退出码 2 结束。

开发验证环境：Windows 11 + MATLAB R2026a + 官方 DSH Desktop 0.2.1-rc.3；插件在真实 DPARSF QC 流程中验证过截图与命令行文本读取。

## 8. 已知取舍与限制

- 文本依赖 CEF 桌面；老版本 MATLAB 只有截图。
- UIA 是启发式拼接：个别超链接文本会产生 `link … out of link` 装饰噪声；MATLAB 自身对超长行截断。
- 最小化窗口不截图（避免打扰），但仍尽量读文本。
- 截图像素包含屏幕内容，隐私边界见 README。

## 9. 代码暂存（`matlab_stage_code`，可选执行）

默认行为是只读；只有当用户明确要求“把代码写进 MATLAB”时，Agent 才调用
`matlab_stage_code`，把**单行代码**放进已打开的命令窗口输入行，但**不执行**。

### 通道选择与验证结论

- **Windows COM（`MATLAB.Application`）不适用**：本机注册表没有该 ProgID；
  即使注册，COM Automation 也无法附着到用户已打开的交互式桌面会话（它会启动
  独立的自动化实例），并且 `Execute()` 是立即执行，违背“用户手动确认执行”。
- **MATLAB Engine（`matlab.engine.shareEngine`）** 需要用户在 MATLAB 中执行共享命令，
  且同样是立即执行，不满足“只写入、不执行”。
- 实际采用的通道：**剪贴板 + 键盘级 Ctrl+V 粘贴到已聚焦的 Command Window 输入行**，
  全程不发送 Enter/Return：
  1. 找到 `MATLAB R20xx` 主窗口，必要时从任务栏恢复并 `SetForegroundWindow`；
  2. 发送 Ctrl+0（MATLAB 的 Command Window 快捷键），通过 UI Automation 的
     `FocusedElement` 校验焦点确实落在 `commandWindowWrapper` 子树内；
  3. 读取 `keyCapture` Edit 的 `ValuePattern`，若提示符后已有未执行文本则拒绝，
     避免与用户正在输入的内容混合；
  4. 将代码放入剪贴板并发送 Ctrl+V，再读回 `keyCapture` 值确认代码已出现在输入行；
  5. 输出机器可读 JSON 状态（`staged` / `draft-not-empty` / `focus-failed` /
     `paste-unverified` / `no-matlab` 等），Host 将其映射为稳定错误类型。

### 安全约束（脚本与 Host 双重校验）

- 拒绝空串、多行（`\r`/`\n`）、NUL、超过 8000 字符的输入；多行粘贴可能被
  MATLAB 逐行执行，因此明确拒绝而不是尝试拼接；
- 从不发送 Enter/Return；工具结果固定写明 “NOT executed”，提示用户按 Enter 或 Esc；
- 焦点校验失败或粘贴校验失败时不重试粘贴，避免把代码误输入到其它窗口；
- 用户手动执行后，Agent 再用 `matlab_snapshot` / `matlab_console` 读取结果。

### 已知取舍

- Ctrl+0 与焦点校验依赖 MATLAB 桌面快捷键和 CEF 的 UI Automation 行为；若用户
  自定义了快捷键、命令窗口被关闭或窗口状态异常，会以 `focus-failed` 拒绝。
- 暂存时会把 MATLAB 窗口切到前台；这是为了让用户立即检查并决定是否执行。
