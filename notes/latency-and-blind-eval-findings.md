# 全量延迟测试与盲测缺陷复核

2026-09-15 · 方法：一个**盲测 subagent**（不知道我的实现细节）+ 我自己的独立测量，两者交叉验证。
所有数字均为实机实测。

---

## 一、延迟：两组独立测量高度一致

| 工具 | subagent median | 我的 median | 一致性 |
|---|---:|---:|---|
| `android_ui_tree` | 6 ms | 7 ms | 一致 |
| `android_ui_tree` (if_moved) | 93 ms | 108 ms | 一致 |
| `android_ui_rows` | 5 ms | 5 ms | 一致 |
| `android_devices` | 94 ms | 129 ms | 有差 |
| `android_screenshot` | 590 ms | 598 ms | 一致 |
| `android_list_apps` | 592 ms | 632 ms | 一致 |
| `android_interact` (tap) | 1102 ms | 1111 ms | 一致 |
| `android_find_text` | 1524 ms | 1537 ms | 一致 |

**两个独立测量者在同一设备上得到几乎相同的数字**，说明测量可信。

### 对照基线（subagent 直接测量）

| 路径 | 耗时 |
|---|---:|
| 原生 `uiautomator dump` | 2491-3275 ms |
| 原生 `screencap` | 518-560 ms |
| 本 fork `android_ui_tree`（bridge）| **6 ms** |

**bridge 仍是最主要收益**：约 400 倍。

---

## 二、缺陷复核结果

盲测列出 8 条。我逐条实测复核，**不是全部成立**：

| # | 盲测结论 | 我的复核 | 判定 |
|---|---|---|---|
| D1 | ui_tree 静默缓存，可能返回陈旧数据 | 缓存安全（改屏后 44 到 210 节点，未陈旧）| **不成立** |
| D2 | `screen` 字段在工具间不一致 | 确认（2524 vs 2560，可复现）| **成立** |
| D3 | `ui_rows` 静默丢行 | 确认（树有 `更多设置`，rows 无；hint 为 null）| **成立** |
| D6 | 每次 tap 都附带截图 | 与实测一致（tap 约等于 screenshot）| **成立** |
| OCR | 依赖 TESSDATA_PREFIX，否则中文静默失效 | 确认，且严重 | **成立** |
| D4/D5/D7/D8 | 未复测 | - | 待验 |

### D1 为什么不成立（重要）

subagent 观察到「重复调用 5-8ms，改参数 80-112ms」，推断「默认路径在缓存、可能返回陈旧数据」。

**观察属实，推断错误。** 实测：

    改屏前：44 节点
    改屏后：210 节点  <- 缓存没有陈旧

真相：默认路径走的是**设备自报的 revision**（设备自己说变没变），所以既快又**安全**；
`if_moved` 额外做一次**主机侧指纹**（`dumpsys window`，约 100ms），所以反而更慢。

**这正是我把指纹改成按需的理由** —— subagent 把「opt-in 的慢」误读成了「默认的快=缓存」。

### D3 为什么只有一半是缺陷

根因是 `src/list-rows.ts:74` 的 `MIN_REPEATED_ROWS = 3`：需要**至少 3 个同构兄弟**才算列表行。

这个规则**是刻意的**，源码注释写明了理由（Android 没有 Cell 类型，重复本身是唯一证据，
2 个可能是双列表头）。所以**丢行是设计**，但：

**`更多设置` 被丢掉时，`hint` 是 null、`omittedOffscreen` 是 0。用户完全无法察觉。**

**沉默才是真缺陷。**

---

## 三、最严重的发现：OCR 中文会静默消失

盲测指出 Tesseract 的语言数据布局问题。**我实测确认，而且比它说的更严重**：

    C:/Program Files/Tesseract-OCR/tessdata/   -> 只有 eng, osd
    C:/Users/BeiWay1145/.tesseract/tessdata/   -> 有 chi_sim, eng, jpn, osd

本机中文能用的**唯一原因**是 `TESSDATA_PREFIX` 指向用户目录 —— **而插件从不设置它**。

实测（清空 `TESSDATA_PREFIX`）：

| | 有 PREFIX | 无 PREFIX |
|---|---:|---:|
| OCR items | 34 | 37 |
| **包含中文** | **是** | **否** |
| 工具状态 | 成功 | **仍然报成功** |

**中文全部消失，而工具报告成功。** 用户看到的是「OCR 读不出中文」，
而真相是语言数据没加载 —— 且**没有任何提示**。

这是我这次新增的代码引入的风险面，必须修。