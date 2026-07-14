/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const sidebar = fs.readFileSync(path.join(__dirname, '..', 'src', 'SidebarProvider.ts'), 'utf8');

function method(name, nextDeclaration) {
  const start = sidebar.indexOf(`private ${name}`);
  const end = sidebar.indexOf(nextDeclaration, start + 1);
  if (start < 0 || end < 0) throw new Error(`Missing method boundary: ${name}`);
  return sidebar.slice(start, end);
}

function assertContains(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`Wave1e liveness ACK notification contract failed: ${label}`);
}

function assertOrder(source, before, after, label) {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);
  if (beforeIndex < 0 || afterIndex < 0 || beforeIndex >= afterIndex) {
    throw new Error(`Wave1e liveness ACK notification contract failed: ${label}`);
  }
}

const showNotification = method('async showWebviewAutoRescueNotification(', '    private async handleExpiredWebviewAutoRescueLateAction(');
const ackHandler = method('handleWebviewLivenessAck(', '    public async debugTriggerWebviewLivenessMissedAck(');

assertContains(ackHandler, 'record.ackAt = Date.now();', 'valid ACK always records ackAt');
assertContains(ackHandler, 'promptMeta && !promptMeta.handled && !promptMeta.expired', 'live prompt metadata gates deferred cleanup');
assertContains(ackHandler, 'webviewAutoRescue.notification.ackDeferredCleanup', 'deferred cleanup marker exists');
assertOrder(ackHandler, 'record.ackAt = Date.now();', 'webviewAutoRescue.notification.ackDeferredCleanup', 'ACK is recorded before cleanup is deferred');
assertContains(ackHandler, 'webviewAutoRescue.notification.ackDeferredCleanup', 'deferred ACK marker precedes an early return');
assertContains(ackHandler, '            return;\n        }\n        record.pending = false;', 'deferred ACK returns before normal record cleanup');

assertContains(showNotification, 'action as WebviewAutoRescueAction, selected)', 'raw selected value reaches stale action handling');
assertContains(showNotification, "if (action === 'Rescue Now')", 'Rescue Now action remains explicit');
assertContains(showNotification, 'await this.executeWebviewAutoRescueSoftRescue(record, action as WebviewAutoRescueAction);', 'Rescue Now reaches guarded soft rescue');
assertContains(showNotification, '} finally {', 'notification completion has guaranteed cleanup');
assertContains(showNotification, 'record.pending = false;', 'completion clears pending for rescue, cancel, and dismiss');
assertContains(showNotification, 'if (this.webviewLivenessCurrent === record)', 'completion only clears matching current record');
assertContains(showNotification, "this.setWebviewAutoRescueState(record, 'idle', 'notification-complete');", 'completion returns lifecycle to idle');

assertContains(sidebar, 'selectedAction=${selectedAction}', 'late action/cancel diagnostics include raw selected value');

console.log('Wave1e liveness ACK notification contract: PASS');
