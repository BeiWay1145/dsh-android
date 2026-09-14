# 方案1 实测结果：常驻无障碍桥接

实测 2026-09-14 · HA1XZ6G8（小米平板5，Android 13，MIUI 14）

## 结论

bridge 生效，且**与 uiautomator 输出在语义上完全一致**，可安全替换。

## 原始 dump 延迟

| 路径 | 耗时 |
|---|---:|
| uiautomator dump（基线） | **2432-2459 ms** |
| bridge（冷启动，含 forward + 惰性握手） | 42-2358 ms（一次性） |
| bridge（热） | **8-12 ms** |

**热态约 250-290 倍**；冷启动一次性成本已被 connect-time warm-up 收拢。

## 工具层延迟（android_ui_tree 真实调用）

| 后端 | 耗时 |
|---|---:|
| bridge | **166 ms** |
| uiautomator（bridge 禁用） | **3341 ms** |
| 加速 | **20.1x** |

工具层低于原始延迟差距，因为工具还要做能力探测、目标解析、结果构建。

## 正确性（关键）

同一屏、背靠背抓取，两者逐项比对：

| 项 | bridge | uiautomator | 一致 |
|---|---|---|---|
| rotation | 1 | 1 | 是 |
| 根节点 bounds | 2560x1500 | 2560x1500 | **是** |
| screenBoundsOf | 2560x1500 | 2560x1500 | **是** |
| 有标签节点 | 17 | 16 | 16/16 全覆盖，0 缺失 |

bridge 多出的 1 个节点是 `flagIncludeNotImportantViews` 带来的额外节点，
属于**超集**（uiautomator 的所有节点都在其中）。

## 修掉的三个坑（都是实测发现）

### 1. app frame 取错三次

| 尝试 | 方式 | 结果 |
|---|---|---:|
| v2 | getCurrentWindowMetrics().getBounds() | 2560x1536（完整显示区） |
| v4 | 再减 systemBars() 60+36 | 2560x1440（**多减 60**） |
| v5 | getWindows() 的 TYPE_APPLICATION | 2560x1536（MIUI 仍报完整区） |
| v6 | 只减 **navigationBars()** | **2560x1500** ✅ |

根因：MIUI 把状态栏做成 overlay（LAYOUT_IN_SCREEN），它**不挤占**应用区；
只有导航栏真正 inset。减 systemBars() 会把不该减的 60px 也减掉。

### 2. accept 线程永久死亡

原实现 catch 后直接 `return`，切换无障碍开关后 socket 消失而进程还活着，
**静默永久失效**。改为指数退避自愈重绑。

### 3. adb forward 惰性握手

新 forward 的**第一次**连接会卡住数秒，第二次仅 ~9ms。
客户端原先把首次超时当成「桥不可用」并缓存 60 秒 TTL。
改为 connect 时主动 warm-up，把一次性成本收拢到建连处。

## 架构要点

- 设备端返回 **uiautomator 同款 XML**，插件解析器零改动
- 桥接是**纯加法**：未安装/未授权/超时/异常一律静默回退到 uiautomator
- 已用四个用例验证回退：无桥、桥返 undefined、桥抛异常、桥正常

## 回退语义（实测）

| 场景 | 行为 |
|---|---|
| 无 bridge 对象 | 走 uiautomator，与改动前一致 |
| bridge 返回 undefined | 回退，execOut 调用 1 次 |
| bridge 抛异常 | 回退，异常不外泄 |
| bridge 正常 | 使用 bridge，execOut 调用 **0** 次 |