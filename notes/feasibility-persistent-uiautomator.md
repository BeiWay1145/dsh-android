# 可行性验证：常驻 uiautomator 服务

实测日期 2026-09-14 · 设备 HA1XZ6G8（小米平板5，Android 13，非 root）

## 结论先行

**假设成立。** uiautomator dump 的 2469 ms 中，约 **2110 ms（85%）是可摊销的固定开销**，
只有约 **360 ms 是真正必须做的树遍历**。

## 分解（各 3 次取均值）

| 组件 | 实测 | 是否可摊销 |
|---|---:|---|
| adb 往返地板 | 71 ms | 不可（但可合并） |
| app_process 纯 JVM 启动 | 509 ms | **可**（常驻后为 0） |
| uiautomator help（JVM + 类加载，无 a11y） | 1157 ms | **可** |
| uiautomator dump 完整 | 2469 ms | — |
| 其中 a11y 连接 + 遍历 + 序列化 | 1312 ms | 部分可（连接可复用） |
| 树体量（launcher） | 1870 B | — |
| screencap -p | 413 ms | 独立通道 |

## 推算的常驻收益

现状:   JVM 509 + 类加载 648 + a11y连接/遍历/序列化 1312 = 2469 ms
常驻:   复用进程与连接 -> 只剩 遍历 + 序列化 + IPC   约 300-400 ms（推算）

推算依据：2470 - 509(JVM) - 1157(类加载) = 804 ms 是 a11y 连接 + 遍历 + 序列化之和。
保守估计常驻后 300-500 ms，即 5-8 倍加速。

注意：300-500ms 是推算，非实测。真机实测需真正实现常驻进程后才有数据。

## 设备约束

| 项 | 值 | 影响 |
|---|---|---|
| ro.build.type | user | 不能直接用 hidden API 反射 |
| ro.debuggable | 0 | 无调试特权 |
| su | Permission denied | 无法走 root 路线 |
| ABI | arm64-v8a | 需编译 arm64 原生组件 |
| 后台进程 | 可行（实测 nohup 存活） | 常驻方案可行 |
| /data/local/tmp | 可写 | 可放组件 |
| 已有 scene-daemon | 运行中（root 所有） | 不建议依赖（第三方、无文档、易失效） |

## 关键设计决定

无 root -> UiAutomation 常规获取路径受限。可行路线：

1. AccessibilityService APK（需用户一次性授权）—— 最稳，能拿到完整无障碍能力
2. shell uid + app_process 常驻 —— 无需安装，但能力受限
3. Instrumentation 测试 APK（am instrument）—— 可复用，但需打包

建议路线 1：一次性授权换长期稳定。
