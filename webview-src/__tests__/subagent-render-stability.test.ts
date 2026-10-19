import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ts from 'typescript';
import { clampSubagentText, scheduleSubagentToolHide, subagentToolRows, visibleSubagentCards } from '../rendering/subagent-tools';

class Element {
    className = ''; textContent = ''; dataset = {}; isConnected = true; children: Element[] = []; parent?: Element;
    styles = new Map<string,string>(); style = {setProperty:(name:string,value:string) => this.styles.set(name,value)};
    listeners = new Map<string,() => void>();
    appendChild(node: Element) { node.parent=this; this.children.push(node); return node; }
    setAttribute() {}
    addEventListener(name:string,fn:() => void) { this.listeners.set(name,fn); }
    remove() { if(this.parent) this.parent.children=this.parent.children.filter(node => node!==this); this.isConnected=false; }
    find(name:string):Element|undefined { return this.className===name ? this : this.children.map(node => node.find(name)).find(Boolean); }
}

test('real subagent renderer keeps collapsed geometry and latest expanded text through streaming/finalizing, with scoped tool dwell', () => {
    jest.useFakeTimers(); jest.setSystemTime(1000);
    try {
        const source=fs.readFileSync(path.join(process.cwd(),'webview-src/rendering/message-renderer.ts'),'utf8');
        const block=source.slice(source.indexOf('// Subagents display inline'),source.indexOf('host.appendMessageImages(div, message);'));
        const document={createElement:() => new Element(),createTextNode:(text:string) => Object.assign(new Element(),{textContent:text})};
        const context=vm.createContext({document,subagentToolRows,visibleSubagentCards,clampSubagentText,scheduleSubagentToolHide});
        vm.runInContext(ts.transpileModule(`function render(host:any,message:any,content:any){${block}}`,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,context);
        const host={activeSessionId:'ses_parent',subagentTextExpandedByKey:new Map(),cleanSubagentTitle:(v:string) => v,
            pickMode:() => '',formatSubagentModel:() => '',renderMarkdownInto:(node:Element,text:string) => {node.textContent=text;}};
        const agent={sessionId:'ses_child',parentSessionId:'ses_parent',title:'Work',state:'running',latestText:'Preview',latestFullText:'Full initial',
            tools:[{sessionId:'ses_child',assistantMessageId:'msg_tool',callId:'call',name:'read',status:'completed',settledAt:1000,input:'file'}]};
        const message={id:'msg_parent',sessionId:'ses_parent',meta:{isThinking:true,subagents:[agent]}};
        const render=() => { const root=new Element(); context.render(host,message,root); return root; };
        let root=render();
        expect(root.find('subagent-inline-tool-group')).toBeDefined();
        expect(root.find('subagent-inline-text')?.styles.get('height')).toBe('auto');
        root.find('subagent-inline-text-toggle')!.listeners.get('click')!();
        expect(root.find('subagent-inline-text')?.textContent).toBe('Full initial');
        expect(root.find('subagent-inline-text')?.styles.get('height')).toBe('auto');
        agent.latestFullText='Full initial plus streamed suffix'; root=render();
        expect(root.find('subagent-inline-text')?.textContent).toBe(agent.latestFullText);
        root.find('subagent-inline-text-toggle')!.listeners.get('click')!();
        agent.state='finalizing'; root=render();
        expect(root.find('subagent-inline-text')?.textContent).toBe('Preview');
        expect(root.find('subagent-inline-text')?.styles.get('height')).toBe('auto');
        jest.advanceTimersByTime(1999); expect(root.find('subagent-inline-tool-group')).toBeDefined();
        jest.advanceTimersByTime(1); expect(root.find('subagent-inline-tool-group')).toBeUndefined();
        expect(agent.tools[0].status).toBe('completed');
        agent.state='done'; expect(render().find('subagent-inline')).toBeUndefined();
    } finally { jest.useRealTimers(); }
});
