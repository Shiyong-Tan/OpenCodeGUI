import { message } from '../transport/protocol/V2Codec';
import { projectHistory } from '../transport/protocol/V2HistoryProjection';
const native = (id: string, type: string, more = {}) => message({ id, type, time: { created: 1 }, ...more }, 'ses_A');
const user = native('msg_user', 'user', { text: 'Fixture' });
const assistant = native('msg_answer', 'assistant', { agent: 'reviewer', model: { providerID: 'provider', id: 'child-model', variant: 'high' },
    finish: 'stop', time: { created: 2, completed: 3 }, content: [{ type: 'text', text: 'Answer' }, { type: 'tool', id: 'call_A', name: 'read', state: { status: 'completed', content: [{ type: 'text', text: 'Read result' }] } }] });
test('provider completion never projects an assistant final without explicit execution outcome', () => {
    const result = projectHistory('ses_A', [user, assistant], false);
    expect(result.messages[1].info).toMatchObject({ id: 'msg_answer', parentID: 'msg_user', modelID: 'child-model', variant: 'high' });
    expect(result.messages[1].info.finish).toBeUndefined();
    expect(result.messages[1].parts[1]).toMatchObject({ callID: 'call_A', state: { status: 'completed', output: 'Read result' } });
});
test('idle outcome completes only the owning last assistant and active execution suppresses stale final', () => {
    const idle = native('msg_idle', 'idle', { outcome: 'succeeded' });
    expect(projectHistory('ses_A', [user, assistant, idle], false).messages[1].info.finish).toBe('stop');
    expect(projectHistory('ses_A', [user, assistant, idle], true).messages[1].info.finish).toBeUndefined();
    const next = native('msg_next', 'user', { text: 'Next' });
    const result = projectHistory('ses_A', [user, assistant, idle, next], true);
    expect(result.messages[1].info.finish).toBe('stop'); expect(result.messages[2].info.role).toBe('user');
});
test('compaction, model selection and unknown controls are retained separately from visible answers', () => {
    const controls = [native('msg_compact', 'compaction', { summary: 'Secret summary', status: 'completed' }), native('msg_model', 'model-switched'), native('msg_future', 'future')];
    const result = projectHistory('ses_A', [user, ...controls, assistant], false);
    expect(result.messages).toHaveLength(2); expect(result.controls).toHaveLength(3);
    expect(JSON.stringify(result.messages)).not.toContain('Secret summary');
});
