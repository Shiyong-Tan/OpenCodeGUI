# DCP 消息过滤 - 修复计划

## TL;DR
> 过滤掉 DCP (Deep Chat Protocol) 元数据消息，不在聊天窗口中显示
> **改动文件**: `media/main.js` (1处)
> **验证**: 编译通过

---

## Context

### 问题描述
用户在聊天窗口中看到很多 DCP 相关的信息作为用户消息显示，例如：
- `▣ DCP | ~158.4K tokens saved total`
- `▣ Pruning (~16.4K tokens) — Noise Removal`

这些是协议的内部元数据，不应该显示给用户。

**关键点**: 消息不一定以 `▣ DCP` 开头，但一定**包含** `▣ DCP`

### 定位结果
问题代码位置：`media/main.js:642` - `upsertMessage` 函数
- 在消息插入 timeline 之前统一过滤
- 一次过滤，覆盖实时消息 + 会话重载
- Metis 建议方案

---

## Work Objectives

### 核心目标
在 `upsertMessage` 函数中添加 DCP 消息过滤，检测消息 text 中是否**包含** `▣ ... DCP ...` 模式。

### 具体改动
在 `media/main.js` 第 642 行后添加：

```javascript
// Filter out DCP (Deep Chat Protocol) metadata messages - they are protocol internals, not user content
if (payload.text && /▣.*DCP/s.test(payload.text)) {
    vscode.postMessage({ type: 'ui-debug', payload: ['[WV][FILTER]', 'DCP-message-filtered', `id=${payload.id}`] });
    return;
}
```

---

## Verification Strategy

### 测试策略
- **编译检查**: `npm run compile` 退出码为 0
- **调试日志**: 过滤消息时会输出 `[WV][FILTER] DCP-message-filtered`

---

## TODOs

- [x] 1. 在 media/main.js 添加 DCP 消息过滤逻辑

  **改动位置**: `media/main.js:642` - `upsertMessage` 函数开头
  
  **改动内容**:
  ```javascript
  function upsertMessage(session, payload) {
      // Filter out DCP (Deep Chat Protocol) metadata messages - they are protocol internals, not user content
      if (payload.text && /▣.*DCP/s.test(payload.text)) {
          vscode.postMessage({ type: 'ui-debug', payload: ['[WV][FILTER]', 'DCP-message-filtered', `id=${payload.id}`] });
          return;
      }
      const existing = session.messagesById.get(payload.id);
      // ... 原有代码继续
  }
  ```

  **Acceptance Criteria**:
  - [x] `npm run compile` 退出码为 0
  - [x] 代码中存在 DCP 过滤正则 `/▣.*DCP/s`

---
---

## Commit

- Message: `fix(webview): filter DCP metadata messages from chat display`
- Files: `media/main.js`
