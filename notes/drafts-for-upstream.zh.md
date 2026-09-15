# 待提交内容草案（**尚未提交任何东西**）

生成 2026-09-14 · 供你审阅后再决定

---

## 选项 A：提两个 PR（推荐）

### PR 1 —— tap 坐标漂移（最值得提）

**标题**

    fix(tap): normalize by the input space, not the tree's app frame

**问题描述**

每次 tap 会落在比目标低 0~35px 的位置（取决于目标在屏幕上的高度），
靠近屏幕底部的控件**无法命中**。

原因是两处分母不一致：

- `src/tool-uitree.ts:784` 用 UI 树根节点的高度归一化（app 帧，实测 1500）
- `src/android-host.ts #pixels` 用截屏帧的高度还原（完整显示区，实测 1536）

两者共享原点但**范围不同**（差 36px 系统栏），缩放系数 1536/1500 = 1.024。

实测漂移（小米平板5 / MIUI 14 / 横屏 2560x1536，app 帧 2560x1500）：

| 目标 y | 意图点 | 实际落点 | 漂移 |
|---:|---:|---:|---:|
| 132 | 132 | 135 | +3 px |
| 838 | 838 | 858 | +20 px |
| 1418 | 1418 | 1452 | +34 px |
| 1472 | 1472 | 1507 | **+35 px（越过 app 帧，被手势条吞掉）** |

**修复**

新增 `treePixelToInput(pixel, input, round)`：像素**不缩放**（两空间共享原点与刻度），
只用 input 空间做分母；host 暴露 `inputSpace(serial)`，与 `#pixels` **同源**。

顺带修 `inputSpace` 回退到 `wm size` 时**不感知旋转**（横屏轴对调）。

**验证**：修复后四个位置的 round-trip 漂移均为 **0 px**；
真机上点安装按钮从「无反应」变为「成功安装」。

**改动面**：`android-host.ts` +17、`tool-uitree.ts` +19、`tool-list-rows.ts` +12、`uitree.ts` +46

---

### PR 2 —— 图像链路静默失效

**标题**

    fix(vision): resolve the image seam lazily and accept both commit entries

**问题描述**

`resolveVisionServices(ctx)` 在 `index.ts:253` 被调用一次，结果被缓存。
但 cordis 的 `ctx.get(name)` 默认 `strict=true`，只在提供方 fiber 处于 active 时返回服务。
`attachments` 是可选服务，无权保证先激活 → 抢跑就把 `{}` 冻结。

**叠加**：守卫只检查 `saveImage`，而挂载的 `LocalAttachmentStore` 同时有
`saveImages`（文档化的批量入口）。

**后果**：截图工具**从未真正把图交给模型**，且完全静默 ——
无错误、无日志，行为与文本路由无法区分。

**修复**：惰性 getter 每次重读 + 接受任一入口。

**改动面**：`vision.ts` +80 −6

---

## 选项 B：先提 issue（对 B1 / C 类更合适）

### issue 草案：直连 adb server 省掉进程启动

**要点**：`resolveTarget()` 每次调用 spawn 一个 `adb devices -l`。
实测 `adb version`（仅 spawn + 握手）就要 **51 ms**，而 `adb devices -l` 是 59 ms
—— **枚举本身只要 6 ms，51 ms 全是启动进程**。

缓存结果没用；直接跟 adb server（127.0.0.1:5037）说长度前缀协议只要 **0–1 ms**，
输出与 CLI 逐字节相同。

**为什么先提 issue**：需要新增一个文件（`adb-server.ts`，142 行无依赖），
且属于绕过官方 CLI，值不值得由维护者定。

---

## 我不建议动的

- **C1 actionable 视图**：新增 API 表面，且收益依赖 agent 主动使用
- **C2 反截断**：改变输出语义，可能影响现有调用方
- **C3 bridge**：需要装 APK，与「纯 adb 零安装」哲学背离

这三项建议**先沟通方向**，不直接提 patch。

---

## 提交前需要你确认的事

1. **提交到哪个仓库？** 上游是 `ZSeven-W/dsh-android`。你的 fork 是 `BeiWay1145`。
   PR 应发到上游。
2. **PR 的根基**：我的改动建立在一串本地 commit 之上（含 bridge、if_moved 等）。
   PR 必须是**从上游 main 拉出的独立分支**，只含这一项修复 —— 不能直接推我的分支。
3. **署名**：用什么名字/邮箱？（当前 commit 用的是 `BeiWay1145`）
4. **是否两件一起提**：A1 与 A2 互不依赖，可分别提。