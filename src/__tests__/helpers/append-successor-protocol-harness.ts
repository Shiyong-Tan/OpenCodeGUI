import * as fs from 'fs';
import * as path from 'path';

/** Reads the real inline dispatcher boundaries used by append-followup protocol tests. */
export function inspectAppendFollowupInlineDispatcher() {
    const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
    const dispatcher = source.indexOf("window.addEventListener('message', (event) => {");
    return {
        source,
        dispatcher,
        turnInFlight: source.indexOf("case 'turnInFlight':", dispatcher),
        assistantMeta: source.indexOf("case 'assistantMessageMeta':", dispatcher),
        indexDelta: source.indexOf("case 'messageIndexMapDelta':", dispatcher),
        extractedHelper: source.indexOf('applyAppendSuccessorProtocolTransition'),
    };
}
