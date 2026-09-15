# Windows/Linux OCR 可行性实测

2026-09-15 · 针对 `android_find_text` / `android_tap_text` / `android_wait_for`
依赖 macOS Vision 框架的问题。

## 现状

`src/ocr-backend.ts:206` 有硬门禁：

```ts
if (process.platform !== 'darwin') {
  return { available: false, reason: 'OCR needs the Vision framework of a macOS host...' }
}
```

三个工具因此在 Windows 上**完全不可用**，且测试套件里对应断言也失败
（`dev-uitree-smoke` 的 `legacy DSH_ANDROID_SWIFTC` 就是这条）。

## 本机可用的替代引擎（实测）

| 引擎 | 状态 | 说明 |
|---|---|---|
| **Tesseract 5.4.0** | ✅ **已装** | `C:/Program Files/Tesseract-OCR/`，含 `chi_sim` + `eng` + `jpn` |
| PaddleOCR | ✅ 有 MCP venv | 更准但更重，需 Python 常驻 |
| macOS Vision | ❌ 不适用 | 当前平台无法使用 |

## Tesseract 实测结果

在一张真实截图（小米平板5 设置页，237981 字节）上：

| 项 | 结果 |
|---|---|
| 耗时 | **1200-1250 ms**（4 次，稳定） |
| 对比 screencap | ~420 ms |
| 中文识别置信度 | **92-97%** |

识别正确性抽样（`--psm 11 tsv`）：

    "设置"        conf=0.94
    "搜索系统设置项"  conf=0.93
    "网络加速"      conf=0.96
    "WLAN"       conf=0.96
    "蓝牙"        conf=0.92

## 关键发现：CJK 的**分词粒度**问题

Tesseract 的 `tsv` 在 **word 级（level 5）把中文拆成单字**：

    晚 | 上 | 10:55 | 9 | 月 | 15 | 日 | 周 | 二 | ...

而插件的匹配逻辑是**精确 → 子串**（`src/tool-uitree.ts` 的 `ocrTextPresent`）：

```ts
const exact = items.find(item => item.text === text)
if (exact !== undefined) return exact
return items.find(item => item.text.toLowerCase().includes(needle))
```

**直接接 word 级输出会全部匹配失败**（实测）：

    "设置"   NO MATCH      ← 输出是 "设" 和 "置" 两个独立项
    "WLAN"  MATCH

### 解法：按 line 聚合

TSV 第 2/3/4 列是 block/paragraph/line 编号，用它把同一行的 words 拼回整行。
**实测可用**：

    1/5/1   (57,196)   "设置"
    1/8/1   (88,331)   "Q搜索系统设置项"
    1/9/1   (650,355)  "网络加速"

聚合后同样查询**全部命中**：

| 查询 | 结果 | 坐标 |
|---|---|---|
| `设置` | ✅ conf=0.94 | (57,196,125x82) |
| `搜索系统设置项` | ✅ conf=0.93 | (88,331,267x30) |
| `网络加速` | ✅ conf=0.96 | (650,355,144x55) |
| `蓝牙` | ✅ conf=0.92 | (151,1328,74x52) |

**注意**：TSV 的 level 4（line）行本身**没有文字**（第 12 列为空），
所以必须自己从 words 聚合，不能直接读 line 行。

## 结论

**在 Windows 上做 OCR 是可行的**，Tesseract 完全够用（92-97% 置信度），
唯一的工程点是把 word 级结果按 line 聚合，以匹配插件的既有契约。

代价：每次 OCR 约 **1.2 秒**（Vision 在 macOS 上通常更快）。
对 `android_find_text` 可接受；对 `android_wait_for` 的轮询（600ms 间隔）
则需要调整节奏。