# 测量 bridge 恢复时间：口径比数字重要

这份笔记记录的是一次真实的测量翻车，以及正确的口径。留着它，是因为
**错误的口径会给出看起来非常合理、但完全错误的数字**，而那种数字比没有数字更糟。

## 教训：1551ms 的假象

一次验收里，测「解除无障碍绑定后 bridge 多久恢复」，脚本轮询到成功的耗时稳定在
`1551ms`，连续 5 轮是 `1546, 1552, 1565, 1553, 1564`。数据高度一致，看起来非常可信。

但同一时刻读设备日志，真实的 `connected -> listening` 间隔是 **43ms**。

那 1500ms 全部是脚本自身的开销：

| 开销来源 | 量级 |
| --- | --- |
| `settings put` 往返（两次） | ~600ms |
| `adb forward --remove-all` + 重建 | ~300ms |
| 每次轮询失败后的固定间隔 | ~100ms × N |
| `call()` 单次超时预算 | 最多 1200ms |

**结论：轮询测的是脚本，不是被测对象。** 凡是"轮询到成功"的耗时，都混入了调用方开销，
除非能把开销证明性地压到远小于被测信号。

## 正确口径：读设备侧的两个时刻

```
adb logcat -d -v time | grep dsh-bridge
  I/dsh-bridge: accessibility service connected      <- onServiceConnected 进入
  I/dsh-bridge: listening on localabstract:dsh_bridge <- 监听真正就绪
```

这两行的时间差就是「一次重绑定让调用方等多久」，不含任何宿主侧开销。
它同时也是报告里 4s / 11s 描述的那个量。

```bash
node scripts/dev-bridge-rebind-live.mjs          # 真机跑 E1 + E2
```

脚本同时打印两个数（设备侧 / 轮询参考），**判定只看设备侧**，轮询列留着是为了
让两者的差距一直可见 —— 差距本身就是一个警告信号。

## 判定基线

| 场景 | 报告基线 | 修复后 | 判定 |
| --- | --- | --- | --- |
| E1 单次重绑定 | 4007 ms | 43 ms | <1000ms |
| E2 连续 5 次 | 10972 ms | 43-83 ms | <2000ms |
| bindFail | — | 0 | ==0 |

## 测量时必须保持屏幕常亮

不常亮会得到**整个测试全错**的结果，而且错得很隐蔽。见 skill 里的
「A sleeping screen makes the bridge look dead」：屏幕熄灭会冻结进程，
表现是「连接 1ms 建立成功，然后永远没有应答」。

```bash
adb shell input keyevent KEYCODE_WAKEUP
adb shell svc power stayon true      # 测量期间常亮
adb shell dumpsys power | grep mWakefulness=   # 确认是 Awake
```

## 另一个坑：每次探活前重建 adb forward

服务被解绑后，`adb forward` 持有的那条连接会挂在一个已死的 socket 上，
此时抽象名不释放 —— 新的 TCP 连接仍能握手成功，但**没有任何人在 accept**，
于是又变成"连上但不说话"。

```bash
adb forward --remove-all
adb forward tcp:28765 localabstract:dsh_bridge
```

测量循环里每次探活前都做一次，否则测到的是残留连接，不是当前状态。
