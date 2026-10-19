import { discoverNativeRequests } from '../NativeRequestDiscovery';
import { PermissionReviewService, type PermissionConnection } from '../PermissionReviewService';

function setup() {
    const parents: Record<string,string|undefined> = {ses_parent:undefined,ses_child:'ses_parent',ses_nested:'ses_child',ses_foreign:undefined};
    const request = (id:string,sessionId='ses_child') => ({id,sessionId,permission:'external_directory',patterns:['external/path'],
        tool:{messageID:'msg_A',callID:id}});
    let hints: ReturnType<typeof request>[] = [], active=['ses_child'];
    const pending: Record<string,ReturnType<typeof request>[]>={ses_child:[request('per_A')]};
    const owned=jest.fn(async (id:string)=>pending[id]??[]);
    const session=jest.fn(async (id:string)=>{if(!(id in parents))throw Error('Missing session');return{id,parentId:parents[id]};});
    const read=()=>discoverNativeRequests('ses_parent',{global:async()=>hints,active:async()=>active,session,owned});
    const respond=jest.fn(async()=>undefined);
    const connection: PermissionConnection={identity:'service',directory:'D:/fixture',read:async()=>{throw Error('No legacy reads');},reply:jest.fn(),native:{
        session:async id=>({id,directory:'D:/fixture',parentID:parents[id],title:'Child'}),
        requests:async()=> (await read()).map(value=>({...value,sessionID:value.sessionId})),
        message:async id=>({info:{id:'msg_A',sessionID:id},parts:(pending[id]??[]).map(value=>({type:'tool',callID:value.id,tool:'read',state:{status:'running',input:{path:'external/path'}}}))}),
        respond,
    }};
    return {request,read,owned,session,parents,pending,respond,connection,service:()=>new PermissionReviewService(async()=>connection),
        hints:(value:typeof hints)=>{hints=value;},active:(value:string[])=>{active=value;}};
}

test('empty location list still produces an actionable child card, including a fresh parent view',async()=>{
    const x=setup();
    for(let reload=0;reload<2;reload++) {
        const cards=(await x.service().snapshot('ses_parent')).requests;
        expect(cards).toHaveLength(1);expect(cards[0]).toMatchObject({sessionId:'ses_child',requestId:'per_A',state:'pending',tool:'read'});
        expect(cards[0].reviewToken).not.toBe('');
    }
    expect(x.respond).not.toHaveBeenCalled();
    expect(x.owned.mock.calls.map(([id])=>id)).toEqual(['ses_parent','ses_child','ses_parent','ses_child']);
});

test('concurrent nested child requests retain their owners and exclude a foreign root',async()=>{
    const x=setup();x.active(['ses_child','ses_nested','ses_foreign']);
    x.pending.ses_nested=[x.request('per_B','ses_nested')];x.pending.ses_foreign=[x.request('per_C','ses_foreign')];
    expect((await x.read()).map(value=>[value.sessionId,value.id])).toEqual([['ses_child','per_A'],['ses_nested','per_B']]);
    expect(x.owned).not.toHaveBeenCalledWith('ses_foreign');
});

test('session endpoint settles stale hints and prevents responding after cancellation',async()=>{
    const x=setup(),service=x.service(),card=(await service.snapshot('ses_parent')).requests[0];
    x.hints([x.request('per_A')]);x.active([]);x.pending.ses_child=[];
    expect((await service.snapshot('ses_parent')).requests).toEqual([]);
    await expect(service.respond({...card,response:'once'})).rejects.toThrow(/expired|belongs/);
    expect(x.respond).not.toHaveBeenCalled();
});

test('explicit decision revalidates and routes to the original child and request',async()=>{
    const x=setup(),service=x.service(),card=(await service.snapshot('ses_parent')).requests[0];
    await expect(service.respond({...card,sessionId:'ses_parent',response:'once'})).rejects.toThrow(/expired|belongs/);
    expect(x.respond).not.toHaveBeenCalled();
    await service.respond({...card,response:'reject'});
    expect(x.respond).toHaveBeenCalledWith(expect.objectContaining({sessionId:'ses_child',requestId:'per_A',response:'reject'}));
    expect(x.respond).toHaveBeenCalledTimes(1);
});

test('known pending owners remain discoverable when the active list no longer includes them',async()=>{
    const x=setup();x.active([]);
    const result=await discoverNativeRequests('ses_parent',{global:async()=>[],active:async()=>[],known:['ses_child'],session:x.session,owned:x.owned});
    expect(result.map(request=>request.id)).toEqual(['per_A']);
});

test('invalid ancestry, foreign responses and duplicate request identities fail closed',async()=>{
    const x=setup();x.parents.ses_child='ses_child';await expect(x.read()).rejects.toThrow(/ancestry/);
    x.parents.ses_child='ses_parent';x.pending.ses_child=[x.request('per_A','ses_foreign')];await expect(x.read()).rejects.toThrow(/Foreign/);
    x.pending.ses_child=[x.request('per_A'),x.request('per_A')];await expect(x.read()).rejects.toThrow(/Duplicate/);
});

test('question discovery uses the same session-scoped path when the location form list is empty',async()=>{
    const x=setup();
    const forms=await discoverNativeRequests('ses_parent',{global:async()=>[],active:async()=>['ses_nested'],session:x.session,
        owned:async id=>id==='ses_nested'?[{id:'frm_A',sessionId:id}]:[]});
    expect(forms).toEqual([{id:'frm_A',sessionId:'ses_nested'}]);
});
