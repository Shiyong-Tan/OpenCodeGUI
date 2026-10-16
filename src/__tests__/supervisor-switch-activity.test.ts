jest.mock('vscode', () => ({ window: { createOutputChannel: () => ({ appendLine() {} }) }, workspace: {} }), { virtual: true });
jest.mock('../transport/ServiceActivity', () => ({ queryServiceActivity: jest.fn() }));
import { queryServiceActivity } from '../transport/ServiceActivity';
import { OpenCodeClient } from '../OpenCodeClient';
function harness() {
 const host = Object.create(OpenCodeClient.prototype) as any;
 host.bindBackend = jest.fn(async () => undefined);
 Object.assign(host,{ workspaceRoot:'workspace', currentSessionId:'A', turnFinalWaitersBySession:new Map(), manualCompactions:new Map(), getServerConn:jest.fn(async()=>({port:42000,lock:{password:'fixture'}})),checkServerHealth:jest.fn(async()=>'ok'),getSupervisorStatus:jest.fn(()=>'disabled'),readSupervisorState:jest.fn() });
 return host;
}
beforeEach(()=>jest.clearAllMocks());
test('in-flight turns and compaction block switching before any service calls',async()=>{
 const host=harness();host.turnFinalWaitersBySession.set('B',[]);
 await expect(host.assertSupervisorSwitchIdle()).rejects.toThrow('locked');expect(host.getServerConn).not.toHaveBeenCalled();
 host.turnFinalWaitersBySession.clear();host.manualCompactions.set('B',{});
 await expect(host.assertSupervisorSwitchIdle()).rejects.toThrow('locked');
});
test('server activity and unknown activity block switching',async()=>{
 const host=harness();(queryServiceActivity as jest.Mock).mockResolvedValue('active');
 await expect(host.assertSupervisorSwitchIdle()).rejects.toThrow('locked');
 (queryServiceActivity as jest.Mock).mockRejectedValue(new Error('activity unknown'));
 await expect(host.assertSupervisorSwitchIdle()).rejects.toThrow('unknown');
});
test('tracked processes block switching even when model sessions are idle',async()=>{
 const host=harness();(queryServiceActivity as jest.Mock).mockResolvedValue('idle');host.getSupervisorStatus.mockReturnValue('connected');
 host.readSupervisorState.mockResolvedValue({status:'observed',view:{tasks:[],executions:[{phase:'running'}]}});
 await expect(host.assertSupervisorSwitchIdle()).rejects.toThrow('processes are active');
 host.readSupervisorState.mockResolvedValue({status:'observed',view:{tasks:[],executions:[]}});
 await expect(host.assertSupervisorSwitchIdle()).resolves.toBeUndefined();
});

test('final releases the local gate but still verifies remote work before unlocking', async () => {
 const host=harness();host.turnFinalWaitersBySession.set('A',[]);
 await expect(host.assertSupervisorSwitchIdle()).rejects.toThrow('locked');
 host.turnFinalWaitersBySession.delete('A');
 (queryServiceActivity as jest.Mock).mockResolvedValue('active');
 await expect(host.assertSupervisorSwitchIdle()).rejects.toThrow('locked');
 (queryServiceActivity as jest.Mock).mockResolvedValue('idle');
 await expect(host.assertSupervisorSwitchIdle()).resolves.toBeUndefined();
});
