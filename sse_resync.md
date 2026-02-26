# SSE / Resync 机制总览（v1.1.6+）

本文只描述当前代码里的 **SSE 与 Resync 流程机制**（`src/OpenCodeClient.ts`），不包含 UI 视觉层说明。

## 1. 核心目标

- 在正常情况下优先走 SSE 实时流。
- 当 SSE 丢尾、断线、或阶段性不稳定时，用 Resync（`GET /session/:id/message`）补齐。
- Resync 只是兜底，不应长期接管；SSE 一恢复应尽快切回。
- 避免重复文本、重复 final、跨 turn 串消息。

## 2. 关键时序参数

- `resyncCooldownMs = 500`
  - 同一 session 的 limited-resync 最小冷却窗口。
- `rescueStartDelayMs = 20000`
  - final 等待阶段的 rescue 定时器（20s）。
- `resyncLoopDelayMs = 20000`
  - non-final 接管阶段的循环 resync 间隔（20s）。
- `sseDrainQuietMs = 800`
  - final 收敛的 SSE-drain 静默窗口。
- `sseDrainPass2DelayMs = 1000`
  - SSE-drain 第二次确认延迟。
- `settleNoDeltaThreshold = 3`
  - 非 fast-path 的 no-delta 完成阈值（当前主路径基本走 fast-path）。
- `autoResumeEpochThreshold = 5`
  - resync 接管中连续 no-progress 轮次阈值。
- `autoResumeStallMs = 100000`
  - 触发自动续跑（auto-resume）的最小卡住时长（100s）。
- `autoResumeWarnMs = 180000`
  - 卡住提示阈值（3min），仅提示不改写 timeline。

## 3. 关键状态（按 session）

- Turn 基础
  - `turnStateBySession`: turn 是否激活、tmp key、assistant 锚点等。
  - `currentTurnStartedAtBySession`: 当前 turn 起点时间。
  - `currentTurnUserMsgIdBySession`: 当前 turn user 锚点。
  - `currentTurnAssistantMsgIdBySession`: 当前 turn assistant 锚点（辅助）。
- Final 收敛
  - `turnFinalAtBySession`: 是否已进入 finalizing。
  - `turnFinalMsgIdBySession`: 当前 turn 接受的 final msgId。
  - `finalizingMsgIdBySession`: final 锁（同 turn 只锁一个 final msgId）。
  - `turnFinalResolvedBySession`: final 是否已完成（chat await 可返回）。
  - `turnFinalWaitersBySession`: `waitForTurnCompletionFinal` 的等待器。
- SSE 活性 / 计时
  - `lastSseAtBySession`: 最近 SSE 事件时间（同 session 任意事件都会刷新）。
  - `turnSseTextAtBySession`: final 文本最近推进时间。
  - `turnSseDrainTimerBySession`: 800ms drain 定时器。
  - `turnRescueTimerBySession`: 20s rescue 定时器。
- Resync 接管控制
  - `turnRecoveryModeBySession`: `sse | resync`。
  - `turnResyncEpochBySession`: 每次 resync 进入接管时 +1，用于丢弃 stale 回放。
  - `resyncInFlightBySession`: single-flight。
  - `resyncCooldownUntilBySession`: limited-resync 冷却截止时间。
  - `turnResyncLoopTimerBySession`: non-final 接管循环定时器。
- 进度/卡住检测
  - `lastProgressAtBySession` / `lastProgressKeyBySession`: 最近一次确认“有进展”的时间与快照键。
  - `noProgressEpochsBySession` / `noProgressSinceBySession`: 连续无进展计数与起点。
  - `autoResumeCountBySession`: 当前 turn 已触发 auto-resume 次数（0/1/2）。
  - `stallWarnedBySession`: 3 分钟卡住提示去重。
  - `awaitingAutoResumeUserAnchorBySession`: 等待 auto-resume 注入的 user msg 到达后刷新 turn user anchor。

## 4. 事件入口与基础行为

所有 SSE 事件先进入 `handleServerEvent(payload, 'sse')`：

1. 解析出 `sessionId`（message.updated / message.part.updated / session.*）。
2. 记录 `lastSseAtBySession = now`。
3. 尝试 non-final 的“按 session 事件切回 SSE”：`maybeRecoverSseFromResyncBySessionEvent(...)`。
4. `resetRescueTimer(sessionId)`（仅 final 等待阶段有效，且若有 pending drain 定时器则跳过 reset）。
5. 映射事件到 chat events 并下发。

## 5. Turn 生命周期（SSE / Resync 的壳层）

### 5.1 `startTurn(...)`

- 清空上个 turn 的 finalize/resync 状态（`clearFinalizeSessionState('turn-start')`）。
- 记录新 `startedAt`，初始化 `mode=sse, epoch=0`。

### 5.2 `finishTurn(...)`

- 清空 turn 状态、final 状态、rescue/resync loop 定时器。

## 6. Final 阶段完整流程

### 6.1 final 候选识别（`message.updated` assistant）

当 assistant `message.updated` 到来且满足 `isFinal`（`finish` 存在或 `completedAt` 有值）时：

1. `maybeBackfillTurnUserAnchor(...)`：必要时回填 user 锚点。
2. `shouldAcceptTurnCompletionFinal(...)` 判定是否可接受：
   - 必须是 `finish=stop`。
   - 必须在 active turn 内。
   - 排除 compaction summary。
   - 若已有 `turnFinalMsgId` 且相同 msgId，判 duplicate-final（拒绝重复 accept）。
   - 若已有 `finalizing lock`，只接受同 lock msgId。
   - 若未 lock，要求 `parentID === currentTurnUserMsgId`。
   - 该消息自身不能仍有 running tools。
3. 通过后 `markTurnFinal(...)`：
   - 锁定 `finalizingMsgIdBySession`。
   - 写入 `turnFinalMsgIdBySession` / `turnFinalAtBySession`。
   - 重置 settle 计数器。
   - 启动 `scheduleTurnFinalQuiet(...)`。

### 6.2 final 文本推进（`message.part.updated` text）

- 文本按 delta 或长度增量计算 chunk，更新 `assistantTextLengths`，仅追加增量。
- 若该 text 属于当前 final msgId：
  - 记录 `turnSseTextAtBySession`。
  - 触发 `scheduleSseDrainConfirm(...)`：
    - 停掉 rescue watchdog（`watchdog.stop reason=sse-active`）。
    - 安排 800ms 后执行 `runResyncSettleCheck('sse-drain')`。

### 6.3 final settle（`runResyncSettleCheck`）

`inFastPath = reason in {sse-drain, sse-drain-pass2, tool-terminal}`：

- fast-path 不先跑 resync，直接看文本稳定。
- 完成条件（fast-path）：`len > 0 && stable >= 2`。
- 若 `sse-drain` 首次稳定（`stable==1`）且无 pending/running tools，安排 1s 后 pass2。
- 仍不满足时，启动 `startRescueTimer(20s)`。
- 满足则 `resolveTurnFinal(...)`：
  - 标记 resolved。
  - 停止 rescue/drain。
  - 唤醒 `waitForTurnCompletionFinal`。

### 6.4 final rescue

- `waitForTurnCompletionFinal` 会挂 waiter 并启动 rescue timer。
- 20s 到期触发 watchdog：`resyncForChatResolve('watchdog-timeout')`。
- 事件流 close/error/reconnect-fail 时，对所有“正在等 final 的 session”立即触发 `resyncForChatResolve(...)`。

## 7. Non-final 阶段接管流程

### 7.1 进入 resync 接管

- `scheduleSessionResyncLimited(reason)` 在满足条件时触发；通过 cooldown + single-flight 节流。
- active turn 会调用 `beginResyncRecovery(...)`：
  - `mode = resync`
  - `epoch += 1`
- 执行 `resyncLimited(sessionId, epoch)`。

### 7.2 non-final 循环

- 每次 resync 完成后执行 `armNonFinalResyncLoop(...)`。
- 若仍处于 non-final 接管态（`mode=resync` 且未 finalizing），20s 后再触发下一轮 `resyncForChatResolve('loop-non-final')`。

### 7.3 non-final 切回 SSE

- 在 `mode=resync` 且 non-final 状态下，只要同 session 收到任意 SSE 事件：
  - `mode -> sse`
  - `epoch += 1`
  - 停 non-final loop
  - 重启 final-rescue timer（若处于 final waiter 会生效）

## 8. Resync 回放流程（共同底层）

`resyncLimited(sessionId, epoch?)`：

1. 优先拉 recent：`GET /session/:id/message?limit=200`。
   - 若已有 anchor（`lastObservedMsgId`）但 recent 中未命中，fallback 到全量 `GET /session/:id/message`。
   - 冷启动（尚无 anchor）时直接接受 recent，并初始化 anchor，避免首轮必走全量。
2. 逐条应用 `shouldReplayResyncMessage(...)` 过滤：
   - 放行条件 A：`parentID === currentTurnUserMsgId`。
   - 放行条件 B：`role=assistant && createdAt >= currentTurnStartedAt - 2000ms`。
   - compaction-summary 直接排除。
3. 回放 parts（text/tool/diff/patch）到统一映射函数（source='resync'）。
4. 对 assistant final 再走一次 `shouldAcceptTurnCompletionFinal`。
5. 整个扫描/parts/textparts 过程都校验 `isResyncRunActive(sessionId, epoch)`：
   - 若 mode 改回 SSE 或 epoch 变化，立即 `resync.drop.stale` 并中断。

## 9.5 接管卡住自动续跑（Auto-Resume）

仅在 `mode=resync`、turn 未 resolved 时生效；每轮 limited-resync 后评估一次：

1. 先做“有进展”判定：
   - 进展来源：本轮 replay 到了 final/tool 终态，或进度快照键变化（观察到的新 msg/final 文本长度变化）。
   - 若有进展：清零 no-progress 计数，清除卡住提示。
2. 若无进展：
   - `noProgressEpochs + 1`。
   - 若仍有 pending/running tools 或交互 blocker（question/permission），不触发 auto-resume。
3. 当满足 `epochs >= 5 && stallMs >= 100s`：
   - 第一次：发送隐藏 rescue prompt
     - 文本：`[OC_UI_AUTORESUME v1]\nRe-read the last user request and finish the remaining steps.`
     - 走 `POST /session/:id/prompt_async`
     - UI 隐藏该 user 消息，不污染主时间线显示。
   - 第二次再次满足：触发 hard-stop 事件（取消当前 turn + 提示 reload）。
4. 当 `stallMs >= 180s` 且尚未提示过：
   - 下发 `systemNotice` 警告（不进 timeline）。

## 9. “Resync 接管可被 SSE 打断”细分规则

### 9.1 final 场景

`maybeRecoverSseFromResync(sessionId,msgId,reason)` 触发条件：

- 正在等待 final（有 waiter，未 resolved）。
- 当前 `mode=resync`。
- msgId 与当前 final lock/msgId 一致。
- 触发点：
  - final 文本 `part.text.length >= knownLenBefore`（长度相同或增长）
  - 或实际 chunk 增长

动作：`mode=sse`, `epoch+1`, 停 loop, 重启 rescue timer。

### 9.2 non-final 场景

- 条件：`mode=resync`、active turn、尚未进入 finalizing。
- 触发：同 session 任意 SSE 事件。
- 动作同上。

## 10. 频率与节流（实际运行节奏）

- final 收敛优先：`sse-drain(800ms)` + `pass2(1000ms)`。
- final rescue：20s watchdog 一次；每次触发后重挂 20s。
- non-final loop：20s 一次。
- limited-resync：single-flight + 500ms cooldown。
- auto-resume：满足 `epochs>=5 & stall>=100s` 时触发一次；再次满足走 hard-stop。
- stall warn：`>=180s` 触发一次 warning（有新进展会自动 clear）。
- event-stream 断线：等待 final 的 session 立即触发 resync（不等 20s）。

## 11. 交互阻塞（question/permission）

- 有 interactive blocker 时：
  - final rescue 暂停（不推进 settle/resync）。
  - non-final loop 暂停。
  - auto-resume 的 no-progress 计数与 stall 时钟一并暂停（不累计 epochs / 不推进 stallMs）。
- 有 pending/running tools 时：
  - auto-resume 的 no-progress 计数与 stall 时钟同样暂停，避免长工具阶段后立即误触发。
- blocker 清除后：
  - 恢复 non-final loop（若仍在接管态）。
  - 恢复 final rescue（有节流保护）。

## 12. 防重复与一致性保证

- Final 接受去重
  - `turnFinalMsgIdBySession` 防同 msg 重复 accept。
  - final meta dedupe key：`sessionId|messageId|final`。
- 文本去重
  - 依赖 `assistantTextLengths` + delta 规则只追加增量。
- Resync stale 丢弃
  - mode/epoch 改变后，旧 resync 结果在 scan/parts/textparts 任一点都被中止。

## 13. 典型完整时序（final 正常）

1. `prompt_async` 发出，`waitForTurnCompletionFinal` 挂起。
2. SSE 到达 assistant final（`finish=stop`）-> `turn.final.accept` -> `markTurnFinal`。
3. SSE text 连续到达，触发 `scheduleSseDrainConfirm`。
4. 800ms 后 `sse-drain` 检查；必要时 1s pass2。
5. `len>0 && stable>=2` 成立 -> `resolveTurnFinal`。
6. waiters resolve，chat 返回。

## 14. 典型完整时序（SSE 异常 + Resync 补偿）

1. final 已锁定但 SSE 断流/超时。
2. watchdog 或 event error/close 触发 `resyncForChatResolve`。
3. resync 扫描当前 turn 消息并回放；若 final 可接受则进入 settle。
4. 若 SSE 在此期间恢复：
   - mode 立刻切回 SSE，epoch+1，旧 resync 立刻 stale。
5. 继续走 SSE-drain 完成最终 settle。

---

以上即当前版本的 SSE / Resync 全流程机制。若后续改动了阈值或判定条件，应同步更新本文中的“参数”和“触发条件”。
