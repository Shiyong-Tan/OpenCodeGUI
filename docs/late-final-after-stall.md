# Late final after a stall notice

The October 13 log shows a stall notice clearing the command owner and temporary
binding, followed by an accepted backend finish=stop (1908 characters). The send
controller then rejected finalization as stale-command-after-chat.

SidebarProvider owns command identity in turnCommandOwnerBySession. Busy display
in sendInFlightBySession is a presentation/liveness fact and does not determine
whether the captured command still owns a final. autoResumeHardStop clears busy
presentation but retains the command, local key and temporary/canonical assistant
bindings. Same-turn finalization uses the existing chatDone, snapshot and cleanup
pipeline. New sends replace the owner; explicit cancellation removes it. No new
state store, fabricated final, model retry or service restart is introduced.

Regression fixtures cover retained binding, normal cleanup, cross-session isolation,
a newer owner, explicit cancellation, and production send-controller snapshot/chatDone
routing after a stall notice. Existing persisted histories are not rewritten.
