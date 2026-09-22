import { SupervisorAssistantObserver } from '../SupervisorAssistantObserver';
import type { NotificationIdentity } from '../notification-identity-protocol';
const source: NotificationIdentity = { schemaVersion: 1, isolationId: 'lab', instanceId: 'plugin', taskId: 'task', attemptId: 'attempt', parentSessionId: 'ses_a', childSessionId: 'ses_child', notificationId: 'notice', eventId: 'event', messageId: 'msg_notice' };
const info = { role: 'assistant', id: 'msg_reply', sessionID: 'ses_a', parentID: 'msg_notice' };
const part = { id: 'prt_text', type: 'text', sessionID: 'ses_a', messageID: 'msg_reply', text: 'result' };
function fixture() { const lookup = jest.fn(async (session: string, message: string) => session === 'ses_a' && message === 'msg_notice' ? source : undefined); return { lookup, observer: new SupervisorAssistantObserver(lookup) }; }
test('only real nonempty assistant activity produces evidence, metadata is insufficient', async () => {
    const {observer} = fixture();
    expect(await observer.observe('message.updated', {info}, 10)).toBeUndefined();
    expect(await observer.observe('session.status', {sessionID:'ses_a',status:'busy'}, 11)).toBeUndefined();
    expect(await observer.observe('message.part.updated', {part:{...part,text:''}}, 12)).toBeUndefined();
    expect(await observer.observe('message.part.updated', {part}, 20)).toMatchObject({source,assistantMessageId:'msg_reply',observedAt:20,assistantInfo:info});
});
test('unchanged full-part snapshots are deduplicated, changed text remains activity', async () => {
    const {observer} = fixture(); await observer.observe('message.updated',{info},10);
    expect(await observer.observe('message.part.updated',{part},20)).toBeDefined();
    expect(await observer.observe('message.part.updated',{part},30)).toBeUndefined();
    expect(await observer.observe('message.part.updated',{part:{...part,text:'result plus'}},40)).toBeDefined();
});
test('tool activity counts without text; empty placeholders do not', async () => {
    const {observer} = fixture(); await observer.observe('message.updated',{info},10);
    const tool = {...part,id:'prt_tool',type:'tool',text:undefined,callID:'call_a',state:{status:'running',input:{}}};
    expect(await observer.observe('message.part.updated',{part:{...tool,state:undefined}},20)).toBeUndefined();
    expect(await observer.observe('message.part.updated',{part:tool},30)).toBeDefined();
    expect(await observer.observe('message.part.updated',{part:tool},40)).toBeUndefined();
});
test('identical user text, foreign sessions and unknown assistant IDs are never source evidence', async () => {
    const {observer} = fixture();
    await observer.observe('message.updated',{info:{...info,role:'user'}},10);
    expect(await observer.observe('message.part.updated',{part},20)).toBeUndefined();
    await observer.observe('message.updated',{info},30);
    expect(await observer.observe('message.part.updated',{part:{...part,sessionID:'ses_b'}},40)).toBeUndefined();
    expect(await observer.observe('message.part.updated',{part:{...part,messageID:'msg_other'}},50)).toBeUndefined();
});
test('lookups capture exact parent identity; disposal fences a late lookup', async () => {
    let resolve!: (value: NotificationIdentity) => void;
    const lookup = jest.fn(() => new Promise<NotificationIdentity>(r=>{resolve=r;}));
    const observer = new SupervisorAssistantObserver(lookup);
    const pending = observer.observe('message.updated',{info},10);
    expect(lookup).toHaveBeenCalledWith('ses_a','msg_notice');
    observer.dispose(); resolve(source); await pending;
    expect(await observer.observe('message.part.updated',{part},20)).toBeUndefined();
});
test('foreign lookup identity and reassigned canonical message IDs fail closed', async () => {
    const observer = new SupervisorAssistantObserver(async()=>({...source,parentSessionId:'ses_b'}));
    await expect(observer.observe('message.updated',{info},10)).rejects.toThrow('ownership mismatch');
    const valid = new SupervisorAssistantObserver(async(session,message)=>({...source,parentSessionId:session,messageId:message}));
    await valid.observe('message.updated',{info},10);
    await expect(valid.observe('message.updated',{info:{...info,parentID:'msg_other'}},20)).rejects.toThrow('ownership changed');
});
test('delta requires a known trusted assistant and an actual nonempty content field', async () => {
    const {observer} = fixture(); await observer.observe('message.updated',{info},10);
    const delta={sessionID:'ses_a',messageID:'msg_reply',partID:'prt_text',field:'text',delta:'x'};
    expect(await observer.observe('message.part.delta',delta,20)).toMatchObject({observedAt:20});
    expect(await observer.observe('message.part.delta',{...delta,field:'status'},30)).toBeUndefined();
    expect(await observer.observe('message.part.delta',{...delta,delta:''},40)).toBeUndefined();
});
