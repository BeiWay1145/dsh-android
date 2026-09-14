# 可选加速：设备端桥接（dsh-bridge）

本 fork 附带一个**可选**的 Android 端组件，把 UI 树读取从 ~2.4 秒降到 ~3 毫秒。

## 效果（小米平板5 / MIUI 14 实测）

| 路径 | 耗时 |
|---|---:|
| uiautomator dump（原路径） | 3242-4122 ms（p50 **3571**） |
| bridge 原始读取（热） | **2-7 ms**（p50 **4**） |
| bridge 空闲屏重复读取（revision 缓存） | **2-4 ms** |
| **android_ui_tree 工具层** | **p50 40 ms**（n=30，stdev 14） |
| 对比：工具层走 uiautomator 回退 | p50 3998 ms |
| **端到端加速** | **90.9x** |

## 是否必须安装？

**不必须。** 桥接是纯加法：

- 未安装 APK / 未授权 / 服务被杀 / 超时 / 任何异常 → **静默回退**到 uiautomator
- 行为与不回退时**完全一致**（同一套 XML 方言、同样的解析器）
- 只是慢一些

已实测四种回退场景：无桥、桥返回 undefined、桥抛异常、桥正常。
前三种都会正确回退且 uiautomator 只被调用一次；桥正常时 uiautomator 调用 **0** 次。

## 安装步骤

1. 构建 APK（需要 JDK 17 + Android SDK build-tools + platform）：

       pwsh -File scripts/build-bridge.ps1

   产物：`android-bridge/dsh-bridge.apk`

2. 安装到设备。**adb install 在 MIUI 上会被 `INSTALL_FAILED_USER_RESTRICTED` 拦截**，
   改用文件安装：

       adb push android-bridge/dsh-bridge.apk /sdcard/Download/
       adb shell am start -a android.intent.action.VIEW \
         -d file:///sdcard/Download/dsh-bridge.apk \
         -t application/vnd.android.package-archive

   然后在设备上点「安装」。

3. 开启无障碍服务：

   **设置 → 更多设置 → 无障碍 → 已安装的服务 → DSH Bridge → 打开**

   也可以用 adb 开启（shell 有此权限）：

       adb shell settings put secure enabled_accessibility_services \
         '<原值>:com.beiway1145.dshbridge/com.beiway1145.dshbridge.BridgeService'

## 工作原理

- `BridgeService` 是一个常驻的 `AccessibilityService`（系统启动一次后保活）
- 它监听 localabstract socket `dsh_bridge`，按行收发 JSON
- 插件通过 `adb forward` 连过去，一次 dump 就是一个 socket 往返，**不再启动进程**
- 返回的是 **uiautomator 同款 XML**，所以插件解析器零改动

为什么快：原路径每次都要付 0.51s JVM 启动 + 1.16s 类加载；
常驻服务把这两项**付一次**。

## 协议

    {"id":1,"cmd":"ping"}
    {"id":1,"cmd":"dump"}
    {"id":1,"cmd":"revision"}
    {"id":1,"cmd":"dump_if_changed","known":<revision>}

`dump_if_changed` 在内容未变时**不返回 XML**，这是空闲屏 2-4ms 的来源。

## 卸载

停用无障碍服务并卸载 `com.beiway1145.dshbridge` 即可。
插件会自动回到 uiautomator 路径，无需任何配置改动。