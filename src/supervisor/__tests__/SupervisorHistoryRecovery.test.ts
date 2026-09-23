import {supervisorRecoveryCandidate} from '../SupervisorHistoryRecovery';
import type {SupervisorRound} from '../SupervisorRoundStore';
const round:SupervisorRound={roundId:'msg_tool',sessionId:'ses_a',executionId:'msg_tool',kind:'independent',startedAt:100,timingBasis:'first-observed-activity',assistantMessageIds:['msg_tool'],sources:[{schemaVersion:1,isolationId:'lab',instanceId:'plugin',taskId:'task',attemptId:'attempt',parentSessionId:'ses_a',childSessionId:'ses_child',notificationId:'notice',eventId:'event',messageId:'msg_notice'}]};
const raw=[{info:{id:'msg_notice',sessionID:'ses_a',role:'user'}},{info:{id:'msg_tool',sessionID:'ses_a',role:'assistant',parentID:'msg_notice',time:{created:101}},parts:[{type:'tool',state:{status:'running'}}]}];
test('tool-only actual history produces transient recovery evidence without invented text',()=>{
 const before=JSON.stringify(raw),lookup=jest.fn(()=>round);
 expect(supervisorRecoveryCandidate('ses_a',raw,lookup)).toMatchObject({id:'msg_tool',text:'',meta:{supervisorRound:round,parentID:'msg_notice'}});
 expect(JSON.stringify(raw)).toBe(before);
});
test('empty metadata, final, foreign owner and newer user cannot restore a supervisor round',()=>{
 expect(supervisorRecoveryCandidate('ses_a',[raw[0],{...raw[1],parts:[]}],()=>round)).toBeUndefined();
 expect(supervisorRecoveryCandidate('ses_b',raw,()=>round)).toBeUndefined();
 expect(supervisorRecoveryCandidate('ses_a',raw,()=>({...round,final:{assistantMessageId:'msg_tool',observedAt:200}}))).toBeUndefined();
 expect(supervisorRecoveryCandidate('ses_a',[...raw,{info:{id:'msg_newuser',role:'user'}}],()=>round)).toBeUndefined();
 expect(supervisorRecoveryCandidate('ses_a',[raw[0],{...raw[1],info:{...raw[1].info,finish:'stop',time:{created:101,completed:200}}}],()=>round)).toBeUndefined();
});
