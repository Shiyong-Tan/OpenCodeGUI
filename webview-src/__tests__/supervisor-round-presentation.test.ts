import {startSupervisorRoundPresentation,updateSupervisorRoundPresentation,resumeSupervisorRoundPresentation,type SupervisorRoundPresentationHost} from '../supervisor/round-presentation';
import {createTurnLifecycleController} from '../session-runtime/turn-lifecycle';
import {supervisorRoundLabel} from '../supervisor/round-label';
import type {SupervisorRound} from '../../src/supervisor/SupervisorRoundStore';
const round:SupervisorRound={roundId:'msg_new',sessionId:'ses_a',executionId:'msg_new',kind:'independent',startedAt:100,timingBasis:'first-observed-activity',assistantMessageIds:['msg_new'],sources:[{schemaVersion:1,isolationId:'lab',instanceId:'plugin',taskId:'task',attemptId:'attempt',parentSessionId:'ses_a',childSessionId:'ses_child',notificationId:'notice',eventId:'event',messageId:'msg_notice'}]};
function fixture(){
 const old={id:'msg_old',role:'assistant',text:'old final',meta:{processingStartedAt:1,processingCompletedAt:50,isThinking:false}};
 const a={messagesById:new Map([[old.id,old]]),turnLifecycle:{generation:1,phase:'effects-finalized' as const,backendInFlight:false,canonicalAssistantId:'msg_old'}};
 const b={messagesById:new Map()};const lifecycle=createTurnLifecycleController({now:()=>100});
 const host:SupervisorRoundPresentationHost={session:id=>id==='ses_a'?a:b,reset:(_id,session)=>{lifecycle.start(session as typeof a);},upsert:(session,message)=>{session.messagesById.set(message.id,message);return message;}};
 return {host,a,b,old,lifecycle};
}
test('actual start creates only an independent assistant and leaves old final byte-equivalent',()=>{
 const f=fixture(),before=JSON.stringify(f.old);expect(startSupervisorRoundPresentation(f.host,'ses_a',round)).toBe(true);
 expect(JSON.stringify(f.old)).toBe(before);expect(f.a.messagesById.size).toBe(2);expect(f.b.messagesById.size).toBe(0);
 expect(f.lifecycle.read(f.a)).toMatchObject({generation:2,phase:'active'});
 expect(f.a.messagesById.get('msg_new')?.meta).toMatchObject({processingStartedAt:100,supervisorRound:round});
 expect([...f.a.messagesById.values()].some(m=>m.role==='user')).toBe(false);
});
test('duplicate starts and restored final records never create a generation',()=>{
 const f=fixture();startSupervisorRoundPresentation(f.host,'ses_a',round);
 expect(startSupervisorRoundPresentation(f.host,'ses_a',round)).toBe(false);expect(f.lifecycle.read(f.a).generation).toBe(2);
 const newMessage=f.a.messagesById.get('msg_new')!;newMessage.meta.isThinking=false;
 expect(startSupervisorRoundPresentation(f.host,'ses_a',round)).toBe(false);expect(updateSupervisorRoundPresentation(f.host,'ses_a',{...round,startedAt:300})).toBe(false);
});
test('foreign owner and existing-turn association cannot create an independent bubble',()=>{
 const f=fixture();expect(startSupervisorRoundPresentation(f.host,'ses_b',round)).toBe(false);
 expect(startSupervisorRoundPresentation(f.host,'ses_a',{...round,kind:'existing-turn'})).toBe(false);expect(f.a.messagesById.size).toBe(1);
});
test('source updates preserve timing and text and render explicit first-observed label',()=>{
 const f=fixture();startSupervisorRoundPresentation(f.host,'ses_a',round);const next={...round,sources:[...round.sources,{...round.sources[0],notificationId:'notice2',taskId:'task2'}]};
 expect(updateSupervisorRoundPresentation(f.host,'ses_a',next)).toBe(true);
 expect(f.a.messagesById.get('msg_new')?.meta.processingStartedAt).toBe(100);
 expect(supervisorRoundLabel(next)).toContain('监督通知触发 · 从首次观察到活动计时');expect(supervisorRoundLabel(next)).toContain('notice2');
});

test('busy history resume keeps the same partial message and original clock, without a new bubble',()=>{
 const f=fixture(),session=f.host.session('ses_a');
 session.messagesById.set('msg_new',{id:'msg_new',role:'assistant',text:'partial result',meta:{supervisorRound:round,processingStartedAt:100,parentID:'msg_notice'}});
 const old=JSON.stringify(f.old),partial=session.messagesById.get('msg_new');
 expect(resumeSupervisorRoundPresentation(f.host,'ses_a',round,'msg_new')).toBe(true);
 expect(session.messagesById.get('msg_new')).toBe(partial);expect(partial?.text).toBe('partial result');
 expect(partial?.meta?.processingStartedAt).toBe(100);expect(JSON.stringify(f.old)).toBe(old);expect(session.messagesById.size).toBe(2);
 expect(resumeSupervisorRoundPresentation(f.host,'ses_a',round,'msg_new')).toBe(false);
});
test('history resume cannot reopen a completed assistant record',()=>{
 const f=fixture(),session=f.host.session('ses_a');
 session.messagesById.set('msg_new',{id:'msg_new',role:'assistant',text:'final',meta:{supervisorRound:round,processingCompletedAt:500}});
 expect(resumeSupervisorRoundPresentation(f.host,'ses_a',round,'msg_new')).toBe(false);
 expect(f.lifecycle.read(f.a).generation).toBe(1);
});

test('trusted busy tool-only resume restores transient presentation once without changing old final',()=>{
 const f=fixture(),before=JSON.stringify(f.old);
 expect(resumeSupervisorRoundPresentation(f.host,'ses_a',round,'msg_new')).toBe(true);
 expect(f.a.messagesById.get('msg_new')?.meta).toMatchObject({isThinking:true,processingStartedAt:100,supervisorRound:round});
 expect(JSON.stringify(f.old)).toBe(before);
 expect(resumeSupervisorRoundPresentation(f.host,'ses_a',round,'msg_new')).toBe(false);
 expect(f.a.messagesById.size).toBe(2);
});
