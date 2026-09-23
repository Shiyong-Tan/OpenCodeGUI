import type {SupervisorRound} from './SupervisorRoundStore';
interface RawMessage {info?:{id?:string;sessionID?:string;role?:string;parentID?:string;finish?:string;time?:{created?:number;completed?:number}};parts?:Array<{type?:string;text?:string;state?:{status?:string}}>}
/** Read-only recovery evidence; never inserted into a finalized history snapshot. */
export function supervisorRecoveryCandidate(sessionId:string,raw:unknown,lookup:(assistantId:string,parentId:string)=>SupervisorRound|undefined) {
 if(!Array.isArray(raw))return undefined;
 const messages=raw as RawMessage[];
 const user=[...messages].reverse().find(m=>m?.info?.role==='user');
 if(!user?.info?.id)return undefined;
 const assistant=[...messages].reverse().find(m=>m?.info?.role==='assistant');
 const info=assistant?.info;
 if(!info?.id||!/^msg_[A-Za-z0-9_-]+$/.test(info.id)||info.sessionID!==sessionId||info.parentID!==user.info.id)return undefined;
 if(info.time?.completed!==undefined&&info.finish!=='tool-calls')return undefined;
 const round=lookup(info.id,info.parentID);
 if(!round||round.final||round.kind!=='independent'||round.sessionId!==sessionId||!round.sources.some(s=>s.parentSessionId===sessionId&&s.messageId===info.parentID))return undefined;
 const activity=assistant?.parts?.some(p=>((p.type==='text'||p.type==='reasoning')&&!!p.text)||(p.type==='tool'&&['pending','running','completed','error'].includes(p.state?.status||'')));
 if(!activity)return undefined;
 return {id:info.id,role:'assistant' as const,text:'',meta:{parentID:info.parentID,timeCreated:info.time?.created,timeCompleted:info.time?.completed,supervisorFinish:info.finish,supervisorRound:round}};
}
