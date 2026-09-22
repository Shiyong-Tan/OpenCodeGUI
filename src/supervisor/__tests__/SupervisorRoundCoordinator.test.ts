import { SupervisorRoundCoordinator } from '../SupervisorRoundCoordinator';
import type { ParentExecution } from '../SupervisorRoundStore';
import type { SupervisorAssistantActivity } from '../SupervisorAssistantObserver';
const source = {schemaVersion:1 as const,isolationId:'lab',instanceId:'plugin',taskId:'task',attemptId:'attempt',parentSessionId:'ses_a',childSessionId:'ses_child',notificationId:'notice',eventId:'event',messageId:'msg_notice'};
const activity: SupervisorAssistantActivity={source,assistantMessageId:'msg_first',observedAt:100,assistantInfo:{id:'msg_first',parentID:'msg_notice'}};
function fixture() {
 const disk=new Map<string,unknown>(); let parent:ParentExecution={kind:'terminal'}; const order:string[]=[];
 const coordinator=new SupervisorRoundCoordinator({storage:()=>({read:async id=>disk.get(id),write:async(id,data)=>{order.push('persist');disk.set(id,data);}}),
 parentExecution:()=>parent,start:round=>{order.push('start');parent={kind:'active',executionId:round.executionId};},update:()=>order.push('update')});
 return {coordinator,disk,order,setParent:(value:ParentExecution)=>{parent=value;}};
}
test('persisted actual activity precedes host start; repeated activity does not start again',async()=>{
 const f=fixture(); expect(await f.coordinator.activity(activity)).toBe('start');expect(f.order).toEqual(['persist','start']);
 expect(await f.coordinator.activity({...activity,observedAt:500})).toBe('continue');expect(f.order).toEqual(['persist','start']);
 expect(f.coordinator.metadata('ses_a','msg_first')?.startedAt).toBe(100);
});
test('final successor identity is durably attached before snapshot projection',async()=>{
 const f=fixture();await f.coordinator.activity(activity);await f.coordinator.finish('ses_a','msg_final',900,'msg_first');
 expect(f.coordinator.metadata('ses_a','msg_final')).toMatchObject({roundId:'msg_first',final:{assistantMessageId:'msg_final',observedAt:900}});
 f.setParent({kind:'terminal'});expect(await f.coordinator.activity({...activity,observedAt:1000})).toBe('drop');
});
test('busy parent retains current turn and groups notices without a new start',async()=>{
 const f=fixture(); f.setParent({kind:'active',executionId:'user_turn'});await f.coordinator.activity(activity);
 await f.coordinator.activity({...activity,assistantMessageId:'msg_next',source:{...source,notificationId:'notice2',messageId:'msg_notice2',taskId:'task2',eventId:'event2'}});
 expect(f.order.filter(v=>v==='start')).toHaveLength(0);expect(f.coordinator.metadata('ses_a','msg_next')).toMatchObject({kind:'existing-turn',executionId:'user_turn'});
});
test('preload restores finalized provenance without changing lifecycle',async()=>{
 const f=fixture();await f.coordinator.activity(activity);await f.coordinator.finish('ses_a','msg_first',900,'msg_first');
 const start=jest.fn();const restored=new SupervisorRoundCoordinator({storage:()=>({read:async id=>f.disk.get(id),write:async()=>{throw Error('unexpected history write');}}),parentExecution:()=>({kind:'terminal'}),start,update:jest.fn()});
 await restored.preload(source);expect(restored.metadata('ses_a','msg_first')?.final?.observedAt).toBe(900);expect(start).not.toHaveBeenCalled();
});

test('late metadata from a finished source cannot mutate a newer execution',async()=>{
 const f=fixture();await f.coordinator.activity(activity);expect(f.coordinator.accepts(source)).toBe(true);
 await f.coordinator.finish('ses_a','msg_first',900,'msg_first');f.setParent({kind:'active',executionId:'new_user_turn'});
 expect(f.coordinator.accepts(source)).toBe(false);
});
