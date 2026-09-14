# 方案1 设计：常驻无障碍服务（dsh-android-bridge）

## 目标

把每次 dump 的 2430 ms 降到 ~300-500 ms，且**不改变插件的对外行为**。

## 架构

```
┌─────────────┐  adb forward tcp:0    ┌──────────────────────┐
│ DSH 插件     │ ───────────────────►  │ 设备: dsh-bridge APK  │
│ (host, TS)  │   local socket        │ AccessibilityService │
│             │ ◄───────────────────  │  + 常驻 socket server │
└─────────────┘   JSON 树             └──────────────────────┘
```

**关键点**：用 `adb forward` 把设备端口映射到 host，**复用同一条 TCP 连接**，
不每次起进程。这与 uiautomator 的"一次调用一个 JVM"是本质区别。

## 传输层选型

| 方案 | 评价 |
|---|---|
| **LocalSocket + adb forward** | ✅ 选它。Text 协议，与现有 `uiautomator dump` 输出可对齐 |
| HTTP server | 也可，但要处理端口冲突与生命周期 |
| stdin/stdout + app_process | ❌ 无 root 拿不到 UiAutomation |

## 协议（行分隔 JSON，一行一请求一响应）

请求：
```json
{"id":1,"cmd":"dump"}
{"id":2,"cmd":"ping"}
{"id":3,"cmd":"dump","maxDepth":5}
```

响应：
```json
{"id":1,"ok":true,"xml":"<hierarchy ...>...</hierarchy>"}
{"id":2,"ok":true,"pong":true,"version":"1"}
{"id":1,"ok":false,"error":"..."}
```

**为什么返回 XML 而不是自建 JSON 树**：插件已有的 `extractHierarchyXml` +
`parseUiTree` 全部复用，**零解析器改动**。这是最重要的设计决定 ——
设备端只负责"快"，不负责"新格式"。

## 降级原则（用户要求）

- 服务未装 / 未授权 / 连接失败 → **静默回退**到现有 `uiautomator dump`
- 回退**不报错、不改行为**，只是慢
- 上游同步不受影响：新路径是**加法**，旧路径永远保留

## 组件清单

1. `android-bridge/` — APK 源码
   - `BridgeService.java` — AccessibilityService，持有 rootInActiveWindow
   - `SocketServer.java` — 常驻 local socket，逐行读 JSON
   - `TreeDumper.java` — AccessibilityNodeInfo → XML（对齐 uiautomator 格式）
2. 插件 host 端
   - `src/bridge-client.ts` — 连接管理、adb forward、超时、回退
   - `src/uitree.ts` — 在 `dumpUiTreeXml` 前插入 bridge 尝试

## XML 格式对齐（必须逐字段一致）

uiautomator 输出：
```xml
<node index="0" text="" resource-id="..." class="android.widget.X"
      package="..." content-desc="..." checkable="false" checked="false"
      clickable="false" enabled="true" focusable="false" focused="false"
      scrollable="false" long-clickable="false" password="false"
      selected="false" bounds="[x1,y1][x2,y2]" />
```

**必须完全一致**，否则插件的 `parseUiTree` 会行为漂移。
