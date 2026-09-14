# 方案2 实测：设备端 revision 缓存

实测 2026-09-14 · HA1XZ6G8

## 思路

设备端的 AccessibilityService **本来就订阅了** window/content 变化事件，
所以它能以近乎零成本回答「自 revision N 以来变了吗」。

这比方案4 的 host 端指纹（~130ms，且要读 dumpsys）更快，也**更准** ——
事件是系统推的，不需要轮询猜测。

## 协议（加法，不改动现有 dump）

    {"cmd":"revision"}                       -> revision 号
    {"cmd":"dump_if_changed","known":N}
        -> 未变: {ok, revision:N, unchanged:true}   不含 XML
        -> 已变: {ok, revision:M, unchanged:false, xml:"..."}

`dump` 也顺带返回 revision，客户端据此缓存。

## 实测

### 空闲屏重复读取

| 次序 | 耗时 |
|---|---:|
| 第 1 次（真 dump） | 56 ms |
| 第 2-6 次（revision 命中） | **2-4 ms** |

### 正确性：永不返回陈旧树

在 4 次屏幕切换（home / settings / recents / home）中，
每次都用「缓存读取」与「强制新 dump」比对全树签名：

| 屏幕 | 缓存 vs 新 dump |
|---|---|
| home | 一致 |
| settings | 一致 |
| recents | 一致 |
| home | 一致 |

**checks: 4 | stale: 0**

### 换屏时确实失效

HOME 之后读取耗时 415 ms（真 dump），不是缓存命中 —— 计数器正确递增。

## 设计取舍

**不做增量 diff**。插件的所有消费者都要完整树；
下发 diff 需要在 host 端重建树，复杂度高、且相对「未变则复用」收益很小。
方案2 的价值就落在**revision 级失效**上，简单且风险低。

**计数器宁可多失效**：任何相关事件都递增。
误判为「变了」只多花一次 dump；误判为「没变」会把陈旧树交给即将操作的 agent。
所以设计上偏向失效，且 `currentRoot()` 始终重读实时窗口。

## 与方案4 的关系

方案4 的 host 端指纹（~130ms）在**没有 bridge** 时仍然有效，保留。
有 bridge 时 revision 检查（2-4ms）优先，两者不冲突。