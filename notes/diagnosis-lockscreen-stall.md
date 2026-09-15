# 诊断：解锁界面卡住 + 3.3M token

会话 `99fa6f23` · 53 次 `run_code` · **257 秒** · 实测 token 统计来自会话日志。

---

## 一、token 花在哪（实测，非估算）

| 项 | 数量 |
|---|---:|
| `inputTokens` 合计 | 46,701 |
| `outputTokens` 合计 | 15,723 |
| **`cacheReadTokens` 合计** | **3,219,072** |

**3.3M 几乎全是 cacheRead** —— 也就是「每一轮都把整个上下文重读一遍」的累积。

上下文从第 1 轮的 **26,112** 涨到最后一轮的 **83,200**，54 轮线性累加：

    26112 + 31744 + 34560 + ... + 83200 = 3,219,072

**这是纯累积效应，不是某一次调用特别贵。** 只要轮数够多、上下文够大，
cacheRead 就必然是这个量级 —— 平均上下文约 60K × 54 轮 ≈ 3.2M。

### 关键：53 次调用**全部**是 `run_code`

一次 `bash`、`android_*` 直接调用都没有。agent 把**所有**操作都包在 `run_code` 里，
而每次 `run_code` 的返回又会把之前的上下文再读一遍。

---

## 二、为什么会卡住：解屏失败引发的死亡螺旋

把 53 次调用按 description 归类：

| 阶段 | 调用编号 | 内容 |
|---|---|---|
| 正常起步 | 0-4 | 加载 skill、读树、尝试上滑解屏 |
| **陷进去** | **5-42** | **~38 次全在跟锁屏/息屏搏斗** |
| 终于出来了 | 43-52 | 解锁成功，正常测试 |

**257 秒里有约 200 秒（78%）花在解锁上。**

### 因果链

从日志实测的关键数字：

| 现象 | 次数 |
|---|---:|
| `KEYCODE_WAKEUP` | **40** |
| `mWakefulness=Asleep` | 8 |
| `mWakefulness=Awake` | 22 |
| **`screencap produced no output`** | **23** |
| keyguard 相关 | 254 |

链条是：

1. 屏幕自动息屏（`Display State=OFF`, `mWakefulness=Asleep`）
2. `screencap` 在息屏下**返回空** → `dsh-android: screencap produced no output`
3. agent 把「screencap 失败」理解成**设备问题**，而不是「屏幕没亮」
4. 于是它开始**排查设备**：查 screencap 实现、读插件源码（16-21）、
   测各种截图方式（8-11、28-31）、试 sleep/wake 循环（31、40）
5. 中间夹着反复的 `KEYCODE_WAKEUP`（40 次），但**唤醒后马上又息屏**

**agent 有 40 次尝试唤醒，却始终没意识到真正的问题是「屏幕又灭了」**。

### 最讽刺的一段

agent 花了 **16-21 号调用（6 次）去读自己插件的源码**，
探讨 `screencap` 为什么失败 —— 而日志显示，同一时间它读到的源码里就写着
**这是息屏时的预期行为**。

---

## 三、真正的问题在哪

### 问题 1：`screencap` 失败时，错误信息**误导性极强**（插件缺陷）

实际报错：

    android_interact: the screencap on HA1XZ6G8 failed:
    dsh-android: screencap produced no output
    — the device may have gone offline; run android_devices to check

**`the device may have gone offline`** —— 这句话把 agent 引向了完全错误的方向。
设备是在线的，只是屏幕灭了。

这个提示**应该**改成：先查 `mWakefulness`，如果是 `Asleep` 就说
「屏幕已息屏，先唤醒」而不是「设备可能掉线」。

**这是插件里一个真实的、可修的缺陷。**

### 问题 2：没有「唤醒并保持」的一等操作

agent 只能反复 `KEYCODE_WAKEUP`，但每次唤醒后屏幕很快又灭
（日志里 Asleep/Awake 交替 8/22 次）。
插件里其实**已经有** `deviceAction('stay-awake')` 之类的能力
（25 号调用「Enable stay-awake-while-charging」说明它自己找到了），
但**不是默认行为**，agent 要摸索很久才发现。

### 问题 3：解锁流程本身没有指引

`android_ui_tree` 在锁屏时返回**只有 4 个节点**的树（实测），
而 PIN 键盘是 MIUI 自绘的，**无障碍树里拿不到数字键**。
agent 试了 37 号「Find numeric keypad buttons」→ 38 号「Tap password digits」，
最后是 42 号「Enter password via adb taps」才成功。

**这个流程其实我有现成的、可用的方法**（上一轮交接文档里就写了），
但它不在 skill 里，所以 agent 只能自己摸。

### 问题 4：53 次全部走 `run_code`（使用方式问题）

`run_code` 适合「一次做多件事」，但 agent 用它做了单次调用。
每次 `run_code` 的往返都让上下文再涨一截。

不过这一条**不是**主要成本 —— 因为 cacheRead 由上下文大小主导，
直接调 `android_*` 也一样会累积。**减少轮数才是关键。**

---

## 四、结论

**3.3M token 的直接原因是「54 轮 × 平均 60K 上下文」的累积，
而 54 轮的成因是「agent 在息屏/锁屏上打转，且错误信息把它引向了错误方向」。**

两件事值得修，都在**插件**这一侧：

| # | 问题 | 修法 | 预期收益 |
|---|---|---|---|
| 1 | `screencap` 失败信息误导 | 先查 `mWakefulness`，区分「息屏」和「掉线」 | **最大** —— 直接掐断错误方向 |
| 2 | 锁屏/PIN 流程无指引 | 写进 skill | 省掉 37-42 那一段摸索 |
| 3 | 唤醒后不保持 | 让息屏检测能自动唤醒或提示 stay-awake | 减少反复 |

**但这些都不是 bridge 或 token 优化能解决的** ——
我这几轮做的 2.4s→3ms、token 省 56%，在这个场景里**一点用都没用上**，
因为 agent 根本没走到需要读大树的路径：锁屏时树只有 4 个节点。

**真正的瓶颈是「agent 不知道自己卡在哪」。**