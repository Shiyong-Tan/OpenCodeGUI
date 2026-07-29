import type { ChatEvent } from '../OpenCodeClient';
import type { FileChangeSpec } from '../undo/types';
import type { FileSnapshot } from '../changes/FileChangeExtractor';

type EventLane = 'main' | 'subagent' | 'unknown';
type EventSource = 'sse' | 'resync' | 'session-idle';

/**
 * Maps one normalized OpenCode server event while preserving the owning client's
 * lifecycle stores and side-effect ordering. The client remains the state owner;
 * this module owns only event interpretation and emission.
 */
export function mapServerEventToChatEvents(
    host: any,
    type: string,
    props: any,
    source: EventSource = 'sse'
): ChatEvent[] {
        const events: ChatEvent[] = [];
        const normalized = host.normalizeEvent(type, props, source);
        const sessionId = normalized.sessionId;
        let appendFollowup: any;
        let appendFollowupStart = false;
        if (source === 'sse' && type === 'message.updated' && props?.info?.role === 'assistant' && sessionId) {
            const info = props.info;
            if (info.finish === 'tool-calls') {
                host.recordAppendFollowupToolCallsBoundary?.(sessionId, info.id, normalized.lane);
            }
            const active = host.getActiveAppendFollowup?.(sessionId);
            if (active) {
                if (info.id !== active.assistantMsgId || info.parentID !== active.appendUserMsgId) {
                    // A's duplicate tool-calls update is harmless; all other late/foreign main messages fail closed.
                    if (!(info.id === active.predecessorAssistantMsgId && info.finish === 'tool-calls')) return events;
                } else {
                    appendFollowup = active;
                }
            } else {
                if (info.finish !== 'tool-calls') {
                    const state = host.appendTurnStateBySession.get(sessionId);
                    if (state?.appendUserMsgIds?.has(info.parentID)) {
                        const result = host.tryBindAppendFollowup?.(sessionId, info.id, info.parentID, normalized.lane);
                        if (result?.status === 'new') {
                            appendFollowup = result.identity;
                            appendFollowupStart = true;
                        } else if (result?.status !== 'existing') {
                            return events;
                        } else {
                            appendFollowup = result.identity;
                        }
                    }
                }
            }
        }
        if (source === 'sse' && type === 'message.part.updated' && sessionId) {
            const part = props?.part;
            const active = host.getActiveAppendFollowup?.(sessionId);
            const messageId = typeof part?.messageID === 'string' ? part.messageID : undefined;
            if (active && messageId && messageId !== active.assistantMsgId && part?.type !== 'tool') return events;
            if (!active && part?.type === 'text' && messageId) {
                host.clearAppendFollowupBoundaryForRenewedContent?.(sessionId, messageId);
            }
            if (active?.assistantMsgId === messageId) appendFollowup = active;
        }
        if (appendFollowupStart) {
            events.push({ type: 'turnInFlight', sessionId, inFlight: true, ownerMsgId: appendFollowup.assistantMsgId, assistantMsgId: appendFollowup.assistantMsgId, appendFollowup, source });
        }
        if (sessionId) {
            host.logUiDebug(`EXT: event.normalized | type=${normalized.type} | lane=${normalized.lane} | sessionId=${normalized.sessionId} | messageId=${normalized.messageId || 'null'} | parentId=${normalized.parentId || 'null'} | finish=${normalized.finish || 'null'} | partType=${normalized.partType || 'null'} | source=${normalized.source}`);
        }
        if (source === 'sse' && sessionId) {
            const pulseRoute = host.resolveBackgroundPulseTarget(sessionId, normalized.lane);
            if (pulseRoute) {
                events.push({
                    type: 'backgroundActivityPulse',
                    sessionId: pulseRoute.targetSessionId,
                    parentSessionId: pulseRoute.parentSessionId,
                    agentSessionId: pulseRoute.agentSessionId,
                    displayTarget: pulseRoute.displayTarget,
                    assistantMsgId: pulseRoute.anchorAssistantId,
                    source,
                    lane: normalized.lane
                });
            }
        }
        // Background completion signal must be intercepted BEFORE the turnFinished guard,
        // because it arrives during the post-final watch window (after finishTurn).
        if (source === 'sse' && sessionId && type === 'message.part.updated') {
            const partForSignal = props?.part;
            if (partForSignal?.type === 'text') {
                const signalText = typeof partForSignal?.text === 'string' ? partForSignal.text : '';
                const signalMsgId = typeof partForSignal?.messageID === 'string' ? partForSignal.messageID : '';
                if (host.isBackgroundCompletionSignal(signalText)) {
                    const reviveArmed = host.handleReviveGate(sessionId);
                    const bootstrapped = reviveArmed && host.bootstrapContinuationTurn(sessionId);
                    if (signalMsgId) {
                        host.rememberHiddenControlUserMsgId(sessionId, signalMsgId);
                    }
                    if (!bootstrapped) {
                        host.logUiDebug(`EXT: background.complete.signal.skip | sessionId=${sessionId} | msgId=${signalMsgId} | reason=revive-not-bootstrapped`);
                        return events;
                    }
                    const chain = host.continuationChainsBySession.get(sessionId);
                    const ownerMsgId = host.postFinalWatchStateBySession.get(sessionId)?.ownerMsgId
                        || chain?.priorAssistantFinalMsgId;
                    events.push({ type: 'turnInFlight', sessionId, inFlight: true, ownerMsgId, source });
                    host.logUiDebug(`EXT: background.complete.signal | sessionId=${sessionId} | msgId=${signalMsgId} | reason=revive-gate-consumed`);
                    return events;
                }
            }
        }
        const isSessionStatus = type === 'session.status';
        if (source === 'sse' && sessionId && host.turnFinishedBySession.has(sessionId) && !isSessionStatus && !appendFollowup) {
            return events;
        }
        if (source === 'resync' && sessionId && (type === 'files' || type === 'diff' || type === 'toolPatch')) {
            const rootSessionId = host.subagentToParentSessionMap.get(sessionId) || sessionId;
            if (host.subagentToParentSessionMap.has(sessionId)) {
                host.logUiDebug(`EXT: resync.subagent.sideeffect.suppressed | rootSessionId=${rootSessionId} | targetSessionId=${sessionId} | reason=resync-sideeffect-protection | source=resync`);
                return [];
            }
        }
        if (type === 'session.created' || type === 'session.updated') {
            if (props?.info?.id) {
                const parentSessionId = typeof props.info?.parentID === 'string' && props.info.parentID.length
                    ? props.info.parentID
                    : undefined;
                events.push({
                    type: 'session',
                    sessionId: props.info.id,
                    parentSessionId,
                    mode: typeof props.info?.mode === 'string' ? props.info.mode : undefined,
                    agent: typeof props.info?.agent === 'string' ? props.info.agent : undefined,
                    modelID: typeof props.info?.modelID === 'string' ? props.info.modelID : undefined,
                    providerID: typeof props.info?.providerID === 'string' ? props.info.providerID : undefined,
                    source,
                });
            }
            return events;
        }
        if (type === 'permission.asked') {
            const permissionId = typeof props?.id === 'string' ? props.id : '';
            const sessionId = typeof props?.sessionID === 'string' ? props.sessionID : '';
            const permission = typeof props?.permission === 'string' ? props.permission : '';
            const patterns = Array.isArray(props?.patterns)
                ? props.patterns.filter((value: any) => typeof value === 'string' && value.length > 0)
                : [];
            if (sessionId && permissionId) {
                host.rememberPendingPermission(sessionId, permissionId);
                events.push({
                    type: 'permissionRequest',
                    sessionId,
                    permissionId,
                    requestId: permissionId,
                    permission,
                    patterns,
                    metadata: props?.metadata,
                    callId: typeof props?.tool?.callID === 'string' ? props.tool.callID : undefined,
                    source,
                });
            }
            return events;
        }
        if (type === 'permission.replied') {
            const sessionId = typeof props?.sessionID === 'string' ? props.sessionID : '';
            const requestId = typeof props?.requestID === 'string' ? props.requestID : '';
            const reply = typeof props?.reply === 'string' ? props.reply : '';
            if (sessionId && requestId) {
                host.clearPendingPermission(sessionId, requestId);
                events.push({
                    type: 'permissionReplied',
                    sessionId,
                    permissionId: requestId,
                    requestId,
                    response: reply === 'always' || reply === 'reject' ? reply : 'once',
                    source,
                });
            }
            return events;
        }
        if (type === 'message.updated') {
            const info = props?.info || {};
            const messageId = info?.id;
            const sessionId = info?.sessionID;
            const role = info?.role;
            let shouldEmitUserMessageEvent = true;
            if (source === 'sse' && typeof sessionId === 'string' && typeof messageId === 'string' && messageId.startsWith('msg_')) {
                host.lastObservedMsgIdBySession.set(sessionId, messageId);
                host.markSessionProgress(sessionId, 'sse-message-updated', messageId);
            }
            if (sessionId && host.canceledActiveTurnBySession.get(sessionId) === true) {
                return events;
            }
			// Extract mode/model from message.updated for subagent sessions
			if (typeof sessionId === 'string' && role === 'assistant' && host.subagentToParentSessionMap.has(sessionId)) {
				const mode = typeof info?.mode === 'string' ? info.mode : undefined;
				const agent = typeof info?.agent === 'string' ? info.agent : undefined;
				const modelID = typeof info?.modelID === 'string' ? info.modelID : undefined;
				const providerID = typeof info?.providerID === 'string' ? info.providerID : undefined;
				if (mode || agent || modelID || providerID) {
					events.push({
						type: 'session',
						sessionId,
						mode,
						agent,
						modelID,
					providerID,
					source,
					});
				}
			}
            const isCompactionSummary = role === 'assistant' && host.isCompactionSummaryInfo(info);
            if (isCompactionSummary && typeof messageId === 'string') {
                host.rememberIgnoredSummaryMessage(sessionId, messageId);
                host.logUiDebug(`EXT: message.ignore | sessionId=${sessionId || 'null'} | msgId=${messageId} | reason=summary-compaction`);
                return events;
            }
            if (sessionId && role === 'assistant' && typeof messageId === 'string') {
                host.pendingAssistantMsgIdBySession.set(sessionId, messageId);
                if (typeof info?.parentID === 'string' && info.parentID.length) {
                    host.pendingUserMsgIdBySession.set(sessionId, info.parentID);
                }
            }
            if (sessionId && role === 'user' && typeof messageId === 'string' && source === 'sse') {
                const appendPrompt = host.bindAppendUserMessage(sessionId, messageId);
                if (appendPrompt) {
                    const rootUserMsgId = host.getAppendRootUserMsgId(sessionId);
                    if (rootUserMsgId) {
                        host.setCurrentTurnUserMsgId(sessionId, rootUserMsgId, 'append-root-user-message');
                    }
                    shouldEmitUserMessageEvent = false;
                }
                if (host.shouldSuppressPendingStopControlUser(sessionId)) {
                    host.pendingStopContinuationUserBySession.delete(sessionId);
                    host.rememberHiddenControlUserMsgId(sessionId, messageId);
                    host.logUiDebug(`EXT: user.ack.updated.skip | sessionId=${sessionId} | msgId=${messageId} | reason=stop-control-pending`);
                    shouldEmitUserMessageEvent = false;
                }
                const isAutoResumeAnchor = host.awaitingAutoResumeUserAnchorBySession.has(sessionId);
                const isSyntheticUser = isAutoResumeAnchor || host.isSyntheticUserMessageInfo(info);
                if (shouldEmitUserMessageEvent && host.turnStateBySession.has(sessionId)) {
                    host.setCurrentTurnUserMsgId(sessionId, messageId, isSyntheticUser ? 'synthetic-override' : 'sse-user-message');
                    if (!isSyntheticUser && !host.hasDisplayTurnUserMsgId(sessionId)) {
                        host.setDisplayTurnUserMsgId(sessionId, messageId, 'sse-user-message');
                    }
                }
                if (shouldEmitUserMessageEvent && isAutoResumeAnchor) {
                    host.setCurrentTurnUserMsgId(sessionId, messageId, 'autoresume-user-anchor');
                    host.awaitingAutoResumeUserAnchorBySession.delete(sessionId);
                    host.markSessionProgress(sessionId, 'autoresume-user-anchor', messageId);
                }
                if (isSyntheticUser) {
                    host.logUiDebug(`EXT: user.ack.updated.skip | sessionId=${sessionId} | msgId=${messageId} | reason=synthetic-user`);
                    shouldEmitUserMessageEvent = false;
                }
            }
            const cwd = info?.path?.cwd;
            if (sessionId && typeof cwd === 'string' && cwd) {
                host.lastCwdBySession.set(sessionId, cwd);
            }
            if (messageId) {
                host.trackTurnMessageId(sessionId, messageId);
                if (typeof role === 'string') {
                    host.messageRoleById.set(messageId, role);
                }
            }
            if (role === 'user' && messageId && source === 'sse') {
                if (shouldEmitUserMessageEvent) {
                    events.push({ type: 'message', text: messageId, sessionId , source });
                }
            }
            if (role === 'assistant' && messageId) {
                const isSubagentLane = typeof sessionId === 'string' && host.subagentToParentSessionMap.has(sessionId) && !appendFollowup;
                const lane: EventLane = isSubagentLane ? 'subagent' : host.classifyEventLane(sessionId);
                const tokens = info?.tokens;
                if (sessionId && tokens && typeof tokens === 'object') {
                    const input = Number(tokens?.input || 0);
                    const output = Number(tokens?.output || 0);
                    const cacheRead = Number(tokens?.cache?.read || 0);
                    const cacheWrite = Number(tokens?.cache?.write || 0);
                    const used = input + output + cacheRead + cacheWrite;
                    if (Number.isFinite(used) && used > 0) {
                        const amount = Number(info?.cost || 0);
                        events.push({
                            type: 'sessionUsage',
                            sessionId,
                            usage: {
                                used,
                                size: 0,
                                amount: Number.isFinite(amount) ? amount : 0
                            },
                            source
                        });
                    }
                }
                if (sessionId && host.shouldSuppressStopContinuationAssistant(sessionId)) {
                    host.rememberHiddenControlAssistantMsgId(sessionId, messageId);
                    host.logUiDebug(`EXT: assistant.updated.skip | sessionId=${sessionId} | msgId=${messageId} | reason=stop-control-window`);
                    return events;
                }
                if (sessionId && typeof info?.parentID === 'string' && host.shouldSuppressHiddenControlAssistant(sessionId, info.parentID)) {
                    host.rememberHiddenControlAssistantMsgId(sessionId, messageId);
                    host.logUiDebug(`EXT: assistant.updated.skip | sessionId=${sessionId} | msgId=${messageId} | reason=hidden-control-parent`);
                    return events;
                }
                if (sessionId && typeof info?.parentID === 'string') {
                    const currentUser = host.currentTurnUserMsgIdBySession.get(sessionId);
                    if (currentUser && info.parentID === currentUser) {
                        host.setCurrentTurnAssistantMsgId(sessionId, messageId, 'assistant-parent-match');
                    }
                }
                const completedAt = info?.time?.completed;
                const isFinal = host.isCompletionFinal(info);
                if (!isFinal || host.hasRunningToolsForMessage(messageId) || info?.finish === 'tool-calls') {
                    host.emitAssistantPhase(events, {
                        sessionId,
                        messageId,
                        parentId: typeof info?.parentID === 'string' ? info.parentID : undefined,
                        source,
                        lane,
                        phase: 'assistant_progress',
                        reason: !isFinal ? 'non-final' : 'running-tools-or-tool-calls'
                    });
                }
                if (isFinal) {
                    host.emitAssistantPhase(events, {
                        sessionId,
                        messageId,
                        parentId: typeof info?.parentID === 'string' ? info.parentID : undefined,
                        source,
                        lane,
                        phase: 'assistant_final_candidate',
                        reason: 'finish-stop'
                    });
                    const messageIndex = host.registerMessage(messageId, sessionId);
                    host.recordAssistantMsgId(sessionId, messageId);
                    let acceptedFinal = false;
                    if (sessionId && !isSubagentLane) {
                        host.maybeBackfillTurnUserAnchor(sessionId, info);
                        if (host.shouldAcceptTurnCompletionFinal(sessionId, info)) {
                            if (source === 'sse' && host.isDelayedMainFinalMode(sessionId)) {
                                host.armPendingMainFinalGate(sessionId, {
                                    messageId,
                                    messageIndex,
                                    parentId: typeof info?.parentID === 'string' ? info.parentID : undefined,
                                    completedAt,
                                    finish: typeof info?.finish === 'string' ? info.finish : undefined,
                                    source,
                                    createdAt: Date.now()
                                });
                                host.logUiDebug(`EXT: turn.final.defer | sessionId=${sessionId} | msgId=${messageId} | mode=${host.expectedMainAgentBySession.get(sessionId) || 'unknown'} | source=${source}`);
                            } else {
                                host.clearPendingMainFinalGate(sessionId, 'immediate-accept');
                                host.logUiDebug(`EXT: turn.final.accept | sessionId=${sessionId} | msgId=${messageId} | finish=${String(info?.finish || '')} | source=${source}`);
                                host.markTurnFinal(sessionId, messageId, source);
                                acceptedFinal = true;
                            }
                        } else {
                            host.logUiDebug(`EXT: turn.final.skip | sessionId=${sessionId} | msgId=${messageId} | finish=${String(info?.finish || '')} | source=${source}`);
                        }
                    } else if (sessionId && isSubagentLane) {
                        const acceptSubFinal = host.shouldAcceptSubagentCompletionFinal(sessionId, info);
                        if (acceptSubFinal) {
                            acceptedFinal = true;
                            host.logUiDebug(`EXT: subagent.final.accept | sessionId=${sessionId} | msgId=${messageId} | finish=${String(info?.finish || '')} | source=${source}`);
                        } else {
                            host.logUiDebug(`EXT: subagent.final.skip | sessionId=${sessionId} | msgId=${messageId} | finish=${String(info?.finish || '')} | source=${source}`);
                        }
                    }
                    const shouldEmit = source === 'sse' && acceptedFinal && host.shouldEmitFinalMeta(sessionId, messageId, completedAt, info?.finish, source);
                    const phase = isSubagentLane ? 'subagent-final-accepted' : 'turn-final-accepted';
                    if (shouldEmit && host.consumePhaseOnce(sessionId, messageId, phase)) {
                        host.emitAssistantPhase(events, {
                            sessionId,
                            messageId,
                            parentId: typeof info?.parentID === 'string' ? info.parentID : undefined,
                            source,
                            lane,
                            phase: 'assistant_final_accepted',
                            reason: isSubagentLane ? 'subagent-final-accepted' : 'turn-final-accepted'
                        });
                        events.push({
                            type: 'assistantMessageMeta',
                            sessionId,
                            assistantMsgId: messageId,
                            messageId,
                            messageIndex,
                            tmpKey: host.getPendingAssistantTmpKey(sessionId),
                            appendFollowup,
                            ...(isSubagentLane ? {
                                parentSessionId: host.getParentSessionForSubagent(sessionId),
                                agentSessionId: sessionId,
                                displayTarget: 'agent-lane' as const
                            } : {}),
                            source,
                        });
                    }
                }
            }
            return events;
        }
        if (type === 'message.part.updated') {
            const part = props?.part || {};
            const sessionId = part?.sessionID;
            if (sessionId && host.canceledActiveTurnBySession.get(sessionId) === true) {
                return events;
            }
            const messageId = typeof part?.messageID === 'string' ? part.messageID : '';
            if (source === 'sse' && typeof sessionId === 'string' && messageId.startsWith('msg_')) {
                host.lastObservedMsgIdBySession.set(sessionId, messageId);
            }
            if (host.isHiddenControlAssistantMsgId(sessionId, messageId)) {
                host.logUiDebug(`EXT: assistant.part.skip | sessionId=${sessionId || 'null'} | msgId=${messageId || 'null'} | reason=hidden-control-assistant`);
                return events;
            }
            if (host.isIgnoredSummaryMessage(sessionId, messageId)) {
                return events;
            }
            const questionOverlay = host.extractQuestionOverlayPart(part);
            if (questionOverlay && sessionId) {
                const key = `${sessionId}|${questionOverlay.callId}|running`;
                if (!host.questionOverlaySeen.has(key)) {
                    host.rememberPendingQuestion(sessionId, questionOverlay);
                    host.questionOverlaySeen.add(key);
                    if (host.questionOverlaySeen.size > 2000) {
                        host.questionOverlaySeen.clear();
                        host.questionOverlaySeen.add(key);
                    }
                    events.push({
                        type: 'questionOverlay',
                        sessionId,
                        callId: questionOverlay.callId,
                        requestId: questionOverlay.requestId,
                        title: questionOverlay.title,
                        prompt: questionOverlay.prompt,
                        options: questionOverlay.options,
                        questions: questionOverlay.questions,
                        source,
                    });
                }
            }
            if (part?.type === 'text') {
                const msgId = typeof part?.messageID === 'string' ? part.messageID : '';
                const knownLenBefore = msgId ? (host.assistantTextLengths.get(msgId) || 0) : 0;
                const roleForMsg = msgId ? host.messageRoleById.get(msgId) : undefined;
                const partTextForGate = host.extractTextPayload(part?.text);
                if (source === 'sse' && sessionId && host.pendingMainFinalGateBySession.has(sessionId) && host.isOmoContinuationText(partTextForGate)) {
                    host.clearPendingMainFinalGate(sessionId, 'boulder-continuation');
                    host.logUiDebug(`EXT: turn.final.pending.cancel | sessionId=${sessionId} | reason=boulder-continuation`);
                }
                if (source === 'sse' && sessionId && msgId && roleForMsg === 'user') {
                    const partText = typeof part?.text === 'string' ? part.text : '';
                    const appendPrompt = host.bindAppendUserMessage(sessionId, msgId) || host.getAppendPromptForUserMessage(sessionId, msgId);
                    if (appendPrompt) {
                        const rootUserMsgId = host.getAppendRootUserMsgId(sessionId);
                        if (rootUserMsgId) {
                            host.setCurrentTurnUserMsgId(sessionId, rootUserMsgId, 'append-root-user-part');
                        }
                        host.markSessionProgress(sessionId, 'append-user-part', msgId);
                        if (host.shouldEmitAppendUserMessage(sessionId, msgId)) {
                            const rootUserMsgId = host.getAppendRootUserMsgId(sessionId);
                            events.push({
                                type: 'appendUserMessage',
                                text: partText || appendPrompt.text,
                                sessionId,
                                messageId: msgId,
                                appendUserMsgId: msgId,
                                rootUserMsgId,
                                clientMessageId: appendPrompt.clientMessageId,
                                source
                            });
                        }
                        return events;
                    }
                    const isAutoResumeControl = host.isAutoResumePromptText(partText);
                    const isHiddenStopControl = host.isStopContinuationPromptText(partText) || host.isOmoContinuationText(partText);
                    if (isAutoResumeControl || isHiddenStopControl) {
                        if (isHiddenStopControl) {
                            host.rememberHiddenControlUserMsgId(sessionId, msgId);
                        }
                        host.setCurrentTurnUserMsgId(sessionId, msgId, 'autoresume-user');
                        host.markSessionProgress(sessionId, 'autoresume-user-seen', msgId);
                        host.logUiDebug(`EXT: user.ack.part.skip | sessionId=${sessionId} | msgId=${msgId} | reason=control-hidden`);
                    } else {
                        host.setCurrentTurnUserMsgId(sessionId, msgId, 'user-ack');
                        if (!host.hasDisplayTurnUserMsgId(sessionId)) {
                            host.setDisplayTurnUserMsgId(sessionId, msgId, 'user-part-ack');
                        }
                        host.markSessionProgress(sessionId, 'user-part-ack', msgId);
                        events.push({ type: 'message', text: msgId, sessionId , source });
                        host.logUiDebug(`EXT: user.ack.part.accept | sessionId=${sessionId} | msgId=${msgId} | reason=role-user`);
                    }
                    return events;
                }
                if (sessionId && msgId) {
                    const assistantId = host.pendingAssistantMsgIdBySession.get(sessionId);
                    if (!assistantId || assistantId !== msgId) {
                        host.pendingUserMsgIdBySession.set(sessionId, msgId);
                    }
                }
                if (msgId) {
                    const role = roleForMsg;
                    if (role && role !== 'assistant') {
                        host.logUiDebug(`EXT: user.ack.part.skip | sessionId=${sessionId || 'null'} | msgId=${msgId} | reason=non-assistant-role:${role}`);
                        return events;
                    }
                }
                // Some providers emit a successor assistant message only through
                // message.part.updated (text + step-finish), without a matching
                // message.updated completion event. Keep the active turn owner in
                // sync with the assistant content that we actually accept so a
                // later session.idle can finalize the correct message.
                if (source === 'sse' && normalized.lane === 'main' && sessionId && msgId && host.turnStateBySession.has(sessionId)) {
                    host.setCurrentTurnAssistantMsgId(sessionId, msgId, 'assistant-text-part');
                    host.recordAssistantMsgId(sessionId, msgId);
                }
                if (source === 'sse' && sessionId && msgId) {
                    const finalMsgId = host.getFinalizingMsgId(sessionId);
                    if (finalMsgId && finalMsgId === msgId && typeof part?.text === 'string' && part.text.length >= knownLenBefore) {
                        host.maybeRecoverSseFromResync(sessionId, msgId, 'text-len-gte');
                    }
                }
                let chunk = '';
                const deltaText = host.extractTextPayload(part?.delta);
                if (deltaText.length > 0) {
                    chunk = deltaText;
                    if (msgId) {
                        host.assistantHasDelta.add(msgId);
                    }
                } else {
                    const partText = host.extractTextPayload(part?.text);
                    // Even if we've seen deltas, if there's new full text beyond what we've shown, emit it
                    const nextLen = partText.length;
                    const partLengthKey = msgId ? host.getAssistantTextLengthPartKey(msgId, part) : '';
                    const prevLen = partLengthKey ? (host.assistantTextLengthsByPart.get(partLengthKey) || 0) : 0;

                    if (nextLen > prevLen) {
                        chunk = partText.slice(prevLen);
                        if (msgId) {
                            host.assistantTextLengthsByPart.set(partLengthKey, nextLen);
                            const aggregateLen = host.assistantTextLengths.get(msgId) || 0;
                            host.assistantTextLengths.set(msgId, Math.max(aggregateLen, nextLen));
                        }
                    } else {
                        chunk = '';
                    }
                }
                if (!chunk) return events;
                if (msgId) {
                    host.appendAssistantText(msgId, chunk);
                }
                if (source === 'sse' && sessionId) {
                    host.markSessionProgress(sessionId, 'sse-text-chunk', msgId || undefined);
                }
                if (source === 'sse' && sessionId && msgId) {
                    host.maybeRecoverSseFromResync(sessionId, msgId, 'text-growth');
                }
                if (source === 'sse' && sessionId && msgId) {
                    const finalMsgId = host.getFinalizingMsgId(sessionId);
                    if (finalMsgId && finalMsgId === msgId) {
                        host.turnSseTextAtBySession.set(sessionId, Date.now());
                        host.scheduleSseDrainConfirm(sessionId);
                    }
                }
                if (msgId && !host.assistantStatusCleared.has(msgId)) {
                    if (msgId === host.getFinalizingMsgId(sessionId)) {
                        const statusParentSessionId = host.getParentSessionForSubagent(sessionId);
                        events.push({
                            type: 'assistantMessageMeta',
                            sessionId,
                            assistantMsgId: part?.messageID,
                            lastText: 'Finalizing the response...',
                            tmpKey: host.getPendingAssistantTmpKey(sessionId),
                            isStatusUpdate: true,
                            ...(statusParentSessionId ? {
                                parentSessionId: statusParentSessionId,
                                agentSessionId: sessionId,
                                displayTarget: 'agent-lane' as const
                            } : {}),
                            source,
                        });
                    }
                    host.assistantStatusCleared.add(msgId);
                }
                const textParentSessionId = appendFollowup ? undefined : host.getParentSessionForSubagent(sessionId);
                events.push({
                    type: 'text',
                    text: chunk,
                    sessionId,
                    assistantMsgId: part?.messageID,
                    tmpKey: host.getPendingAssistantTmpKey(sessionId),
                    appendFollowup,
                    ...(textParentSessionId ? {
                        parentSessionId: textParentSessionId,
                        agentSessionId: sessionId,
                        displayTarget: 'agent-lane' as const
                    } : {}),
                    source
                });
            }
            if (part?.type === 'tool') {
                const messageId = typeof part?.messageID === 'string' ? part.messageID : undefined;
                if (source === 'sse' && sessionId) {
                    host.markSessionProgress(sessionId, 'sse-tool-part', messageId);
                }
                const toolCallId = host.extractToolCallId(part);
                const toolStatus = part?.state?.status;
                const toolState = host.updateToolStatus(sessionId, toolCallId, toolStatus);
                if (sessionId && toolCallId && (toolStatus === 'completed' || toolStatus === 'failed' || toolStatus === 'cancelled' || toolStatus === 'canceled')) {
                    host.clearPendingQuestion(sessionId, toolCallId);
                }
                if (messageId && toolStatus) {
                    const current = host.toolRunningByMessageId.get(messageId) || 0;
                    if (toolStatus === 'running') {
                        host.toolRunningByMessageId.set(messageId, current + 1);
                    } else if (toolStatus === 'completed' || toolStatus === 'failed' || toolStatus === 'cancelled' || toolStatus === 'canceled') {
                        const next = Math.max(0, current - 1);
                        if (next === 0) {
                            host.toolRunningByMessageId.delete(messageId);
                        } else {
                            host.toolRunningByMessageId.set(messageId, next);
                        }
                    }
                }
                const statusText = host.formatToolStatus(part);
                if (statusText && source !== 'resync') {
                    const resolvedId = host.getTurnAssistantMsgId(sessionId);
                    const assistantMsgId = resolvedId || part?.messageID;
                    const statusParentSessionId = host.getParentSessionForSubagent(sessionId);
                    events.push({
                        type: 'assistantMessageMeta',
                        sessionId,
                        assistantMsgId,
                        lastText: statusText,
                        tmpKey: host.getPendingAssistantTmpKey(sessionId),
                        isStatusUpdate: true,
                        ...(statusParentSessionId ? {
                            parentSessionId: statusParentSessionId,
                            agentSessionId: sessionId,
                            displayTarget: 'agent-lane' as const
                        } : {}),
                        source
                    });
                }
                if (typeof sessionId === 'string' && host.subagentToParentSessionMap.has(sessionId)) {
                    const parentSessionId = host.getParentSessionForSubagent(sessionId);
                    const status = part?.state?.status;
                    if ((status === 'running' || status === 'pending') && source !== 'resync') {
                        events.push({
                            type: 'tool',
                            sessionId,
                            parentSessionId,
                            agentSessionId: sessionId,
                            displayTarget: 'agent-lane',
                            tool: statusText || (typeof part?.tool === 'string' ? part.tool : ''),
                            toolState: {
                                status,
                                input: part?.state?.input,
                                output: part?.state?.output,
                            },
                            source,
                        });
                    }
                }
                const toolName = typeof part?.tool === 'string' ? part.tool : '';
                if (sessionId && toolName && source !== 'resync' && !host.subagentToParentSessionMap.has(sessionId)) {
                    events.push({
                        type: 'tool',
                        sessionId,
                        tool: toolName,
                        toolState: {
                            status: toolStatus,
                            input: part?.state?.input,
                            output: part?.state?.output,
                        },
                        source,
                    });
                }
                if (part?.state?.status === 'completed' && sessionId) {
                    if (['apply_patch', 'edit', 'write'].includes(toolName)) {
                        host.markTurnHasWrites(sessionId, `tool:${toolName}`);
                    } else if (toolName === 'bash' && source !== 'resync') {
                        const command = part?.state?.input?.command;
                        if (!host.isBashCommandReadOnly(command)) {
                            host.markTurnHasWrites(sessionId, 'tool:bash');
                        }
                    }
                }
                // Detect todowrite tool completion and emit todoUpdate event
                if (toolName === 'todowrite' && part?.state?.status === 'completed') {
                    const todos = part?.state?.metadata?.todos;
                    if (Array.isArray(todos) && todos.length > 0 && sessionId) {
                        const msgId = host.getTurnAssistantMsgId(sessionId) || part?.messageID || '';
                        const parentSessionId = host.getParentSessionForSubagent(sessionId);
                        if (parentSessionId) {
                            events.push({
                                type: 'todoUpdate',
                                todos,
                                sessionId: parentSessionId,
                                parentSessionId,
                                agentSessionId: sessionId,
                                displayTarget: 'parent',
                                assistantMsgId: msgId,
                                source
                            });
                            host.logUiDebug(`[EXT][SUBAGENT_ROUTE] phase=todoUpdate parentSessionId=${parentSessionId} agentSessionId=${sessionId} displayTarget=parent reason=mapped`);
                        } else if (host.subagentToParentSessionMap.has(sessionId)) {
                            host.logUiDebug(`[EXT][SUBAGENT_ROUTE_DROP] phase=todoUpdate reason=missing-parent parentSessionId=null agentSessionId=${sessionId} displayTarget=parent`);
                        } else {
                            events.push({ type: 'todoUpdate', todos, sessionId, assistantMsgId: msgId , source });
                        }
                    }
                }
                if (source === 'sse' && sessionId && toolState.becameTerminal && !host.hasPendingOrRunningTools(sessionId) && !host.turnFinalResolvedBySession.has(sessionId)) {
                    void host.runResyncSettleCheck(sessionId, 'tool-terminal');
                }
                if (part?.state?.status === 'completed') {
                    const files = host.extractFilesFromToolPart(part);
                    if (files.length) {
                        const changeSpecs = host.buildChangeSpecs(files);
                        if (host.shouldQueueTurnChanges(sessionId, source, part?.messageID)) {
                            const turnState = host.turnStateBySession.get(sessionId);
                            const turnKey = turnState?.pendingUserLocalKey || sessionId;
                            const tmpKey = turnState?.pendingAssistantTmpKey;
                            const assistantId = turnState?.assistantMsgId || turnState?.lastResolvedAssistantMsgId;
                            host.queueTurnChanges(sessionId, turnKey, tmpKey, assistantId, changeSpecs);
                        }
                        host.mirrorChangesToParentSession(sessionId, changeSpecs, source);
                        events.push({ type: 'files', files, sessionId , source });
                    } else if (part?.tool === 'bash' && sessionId) {
                        const command = part?.state?.input?.command;
                        const cwd = host.lastCwdBySession.get(sessionId);
                        const writePaths = host.extractWrittenPathsFromBashCommand(command, cwd);
                        const deletePaths = host.extractDeletedPathsFromCommand(command, cwd);
                        if (writePaths.length || deletePaths.length) {
                            if (host.shouldQueueTurnChanges(sessionId, source, part?.messageID)) {
                                const turnState = host.turnStateBySession.get(sessionId);
                                const turnKey = turnState?.pendingUserLocalKey || sessionId;
                                const tmpKey = turnState?.pendingAssistantTmpKey;
                                const assistantId = turnState?.assistantMsgId || turnState?.lastResolvedAssistantMsgId;
                                const changeSpecs = [
                                    ...writePaths.map((filePath: string) => ({ type: 'update', path: filePath } as FileChangeSpec)),
                                    ...deletePaths.map((filePath: string) => ({ type: 'delete', path: filePath } as FileChangeSpec))
                                ];
                                host.queueTurnChanges(sessionId, turnKey, tmpKey, assistantId, changeSpecs);
                            }
                        }
                    }
            }
        }
        if (part?.type === 'tool' && part?.tool === 'apply_patch') {
            const patchText = part?.state?.input?.patchText || part?.state?.input?.patch;
            const relatedIds = host.getRelatedSessionIds(sessionId);
            const allowDiff = Boolean(sessionId && (host.hasGroupedActiveTurnWrites(sessionId) || host.hasGroupedPendingTurnChanges(sessionId)));
            host.logUiDebug(`[DIFF_GATE] apply_patch allowDiff check | sessionId=${sessionId} relatedCount=${relatedIds.length} relatedIds=[${relatedIds.join(',')}] allowDiff=${allowDiff}`);
            if (patchText && allowDiff) {
                events.push({ type: 'toolPatch', text: patchText, sessionId , source });
            }
        }
        if ((part?.type === 'diff' || part?.type === 'patch') && typeof part?.text === 'string') {
            const diffMessageId = typeof part?.messageID === 'string' ? part.messageID : undefined;
            if (source === 'sse' && sessionId) {
                host.markSessionProgress(sessionId, 'sse-diff-part', diffMessageId);
            }
            const relatedIds = host.getRelatedSessionIds(sessionId);
            const inGrace = Boolean(sessionId && host.isInLateDiffGrace(sessionId));
            const allowDiff = Boolean(sessionId && (host.hasGroupedActiveTurnWrites(sessionId) || host.hasGroupedPendingTurnChanges(sessionId) || inGrace));
            host.logUiDebug(`[DIFF_GATE] diff/patch allowDiff check | sessionId=${sessionId} relatedCount=${relatedIds.length} relatedIds=[${relatedIds.join(',')}] allowDiff=${allowDiff} inGrace=${inGrace}`);
            if (inGrace && sessionId) {
                host.logUiDebug(`[LATE_DIFF] event in grace window | sessionId=${sessionId} eventType=${part?.type}`);
            }
            if (allowDiff) {
                events.push({ type: 'diff', text: part.text, sessionId , source });
            }
        }
        return events;
    }

    if (type === 'session.diff' && Array.isArray(props?.diff)) {
        if (props?.sessionID && host.canceledActiveTurnBySession.get(props.sessionID) === true) {
            return events;
        }
        const sessionId = props?.sessionID as string | undefined;
        if (!sessionId) return events;
        const relatedIds = host.getRelatedSessionIds(sessionId);
        const hasWrites = host.hasGroupedActiveTurnWrites(sessionId);
        const hasPending = host.hasGroupedPendingTurnChanges(sessionId);
        const inGrace = host.isInLateDiffGrace(sessionId);
        host.logUiDebug(`[DIFF_GATE] session.diff gate check | sessionId=${sessionId} relatedCount=${relatedIds.length} relatedIds=[${relatedIds.join(',')}] hasWrites=${hasWrites} hasPending=${hasPending} inGrace=${inGrace}`);
        if (!hasWrites && !hasPending && !inGrace) {
            host.logUiDebug(`EXT: session.diff.skip | sessionId=${sessionId} | reason=no-turn-writes`);
            return events;
        }
        if (inGrace) {
            host.logUiDebug(`[LATE_DIFF] event in grace window | sessionId=${sessionId} eventType=session.diff`);
        }
        const files = props.diff.map((entry: any) => {
            const patchText = host.extractPatchText(entry);
            return {
                filePath: entry.file || entry.filePath || entry.path || entry.relativePath,
                relativePath: typeof entry.relativePath === 'string' ? entry.relativePath : undefined,
                type: (entry.type as 'update' | 'create' | 'delete' | undefined) || (patchText ? 'update' : undefined),
                diff: patchText,
                patch: patchText,
                before: typeof entry.before === 'string' ? entry.before : (typeof entry.from === 'string' ? entry.from : undefined),
                after: typeof entry.after === 'string' ? entry.after : (typeof entry.to === 'string' ? entry.to : undefined),
                existsBefore: typeof entry.existsBefore === 'boolean' ? entry.existsBefore : undefined,
                existsAfter: typeof entry.existsAfter === 'boolean' ? entry.existsAfter : undefined,
                additions: entry.additions,
                deletions: entry.deletions
            };
        }).filter((entry: FileSnapshot) => typeof entry.filePath === 'string' && entry.filePath.length > 0) as FileSnapshot[];
            if (files.length) {
                const changeSpecs = host.buildChangeSpecs(files);
                if (host.gitUndoAvailable && host.isSessionUndoEnabled(props?.sessionID) && props?.sessionID) {
                    const turnState = host.turnStateBySession.get(sessionId);
                    const turnKey = turnState?.pendingUserLocalKey || sessionId;
                    const tmpKey = turnState?.pendingAssistantTmpKey;
                    const assistantId = turnState?.assistantMsgId || turnState?.lastResolvedAssistantMsgId;
                    host.queueTurnChanges(sessionId, turnKey, tmpKey, assistantId, changeSpecs);
                }
                host.mirrorChangesToParentSession(sessionId, changeSpecs, source);
                events.push({ type: 'files', files, sessionId: props?.sessionID , source });
            }
            return events;
        }
        if (type === 'session.status' && props?.sessionID) {
            const sessionId = props.sessionID;
            const status = props?.status || {};
            const usageCarrier = status?.update || status;
            const usageFlag = usageCarrier?.sessionUpdate || status?.type;
            const usedRaw = usageCarrier?.used ?? status?.used;
            const sizeRaw = usageCarrier?.size ?? status?.size;
            const amountRaw = usageCarrier?.cost?.amount ?? status?.cost?.amount;
            host.logUiDebug(`EXT: session.status.detail | sessionId=${sessionId} | type=${String(status?.type || 'null')} | sessionUpdate=${String(usageCarrier?.sessionUpdate || 'null')} | used=${String(usedRaw ?? 'null')} | size=${String(sizeRaw ?? 'null')} | amount=${String(amountRaw ?? 'null')}`);
            const hasUsageShape = Number.isFinite(Number(usedRaw)) && Number.isFinite(Number(sizeRaw));
            const isUsageUpdate =
                usageFlag === 'usage_update'
                || hasUsageShape;
            if (isUsageUpdate) {
                const used = Number.isFinite(Number(usedRaw)) ? Number(usedRaw) : 0;
                const size = Number.isFinite(Number(sizeRaw)) ? Number(sizeRaw) : 0;
                const amount = Number.isFinite(Number(amountRaw)) ? Number(amountRaw) : 0;
                events.push({
                    type: 'sessionUsage',
                    sessionId,
                    usage: { used, size, amount },
                    source
                });
                // Do not return here; idle and usage may coexist in one status payload.
            }
            if (status?.type !== 'idle') {
                return events;
            }
            host.sessionIdleReceivedBySession.add(sessionId);
            host.logUiDebug(`EXT: session.idle.received | sessionId=${sessionId}`);
            if (host.canceledActiveTurnBySession.get(sessionId) === true) {
                return events;
            }
            if (host.turnStateBySession.has(sessionId)) {
                host.handleSessionIdleFinal(sessionId);
            }
            return events;
        }
        if (type === 'session.error') {
            const sessionId = normalized.sessionId;
            const errorName = props?.error?.name || props?.error?.data?.name;
            const message = props?.error?.data?.message || props?.error?.message;
            // Check if user initiated the cancel (not a system abort)
            if (errorName === 'MessageAbortedError') {
                // Guard: sessionId can be undefined, so check before using
                if (sessionId && host.canceledActiveTurnBySession.get(sessionId) === true) {
                    // User cancel: preserve existing behavior (silently drop)
                    return events;
                }
                // Non-user abort: resolve turn immediately (no settle delay)
                if (sessionId) {
                    host.logUiDebug(`EXT: session.error.abort.resolve | sessionId=${sessionId} | reason=message_aborted_non_user`);
                    host.resolveTurnFinal(sessionId, 'session-error-abort');
                }
                return events;
            }
            // General session error: resolve turn immediately (no settle delay)
            if (sessionId) {
                host.logUiDebug(`EXT: session.error.resolve | sessionId=${sessionId} | error=${errorName || 'unknown'} | reason=session_error`);
                host.resolveTurnFinal(sessionId, 'session-error');
            }
            events.push({
                type: 'error',
                text: message || errorName || 'Unknown session error',
                sessionId: props?.sessionID || sessionId,
                source
            });
            return events;
        }
        return events;
    
}
