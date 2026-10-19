import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ts from 'typescript';
import { clampSubagentText, scheduleSubagentToolHide, subagentToolRows, visibleSubagentCards } from '../rendering/subagent-tools';
import { renderSubagentTools, patchSubagentTools } from '../rendering/subagent-tool-renderer';

class Element {
    className = ''; textContent = ''; dataset: Record<string,string> = {}; isConnected = true; children: Element[] = []; parent?: Element;
    styles = new Map<string,string>(); style = {setProperty:(name:string,value:string) => this.styles.set(name,value)};
    listeners = new Map<string,() => void>();
    appendChild(node: Element) { node.parent=this; this.children.push(node); return node; }
    setAttribute() {}
    addEventListener(name:string,fn:() => void) { this.listeners.set(name,fn); }
    remove() { if(this.parent) this.parent.children=this.parent.children.filter(node => node!==this); this.isConnected=false; }
    find(name:string):Element|undefined { return this.className===name ? this : this.children.map(node => node.find(name)).find(Boolean); }
    querySelector(selector:string) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector:string):Element[] {
        const name=selector.replace(':scope > ', '').slice(1);
        const children=selector.startsWith(':scope > ') ? this.children : this.children.flatMap(node => [node,...node.descendants()]);
        return children.filter(node => node.className===name);
    }
    descendants():Element[] { return this.children.flatMap(node => [node,...node.descendants()]); }
}

test('real subagent renderer keeps collapsed geometry and latest expanded text through streaming/finalizing, with scoped tool dwell', () => {
    jest.useFakeTimers(); jest.setSystemTime(1000);
    try {
        const source=fs.readFileSync(path.join(process.cwd(),'webview-src/rendering/message-renderer.ts'),'utf8');
        const block=source.slice(source.indexOf('// Subagents display inline'),source.indexOf('host.appendMessageImages(div, message);'));
        const document={createElement:() => new Element(),createTextNode:(text:string) => Object.assign(new Element(),{textContent:text})};
        const context=vm.createContext({document,subagentToolRows,visibleSubagentCards,clampSubagentText,scheduleSubagentToolHide,renderSubagentTools});
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

test('parallel tool patches retain the running wait DOM node while another tool appears, completes and expires', () => {
    jest.useFakeTimers(); jest.setSystemTime(1000);
    try {
        const root=new Element(), entry=new Element(); entry.className='subagent-inline-entry'; entry.dataset.subagentSessionId='ses_child'; root.appendChild(entry);
        const document={createElement:()=>new Element()} as unknown as Document;
        const dom=root as unknown as HTMLElement;
        const tool=(callId:string,status='running')=>({sessionId:'ses_child',assistantMessageId:'msg_A',callId,name:'read',status,input:''});
        const first={sessionId:'ses_child',parentSessionId:'ses_parent',state:'running',latestText:'Keep',tools:[{...tool('wait'),name:'Running: supervisor_process_wait',progressText:'Elapsed 1m 0s'}]};
        renderSubagentTools(entry as unknown as HTMLElement,subagentToolRows(first)!,document);
        const waitNode=entry.children[0];
        const second={...first,tools:[first.tools[0],tool('read')]};
        expect(patchSubagentTools(dom,[first],[second],document)).toBe(true);
        expect(entry.children[0]).toBe(waitNode); expect(entry.children).toHaveLength(2);
        const completed={...second,tools:[{...first.tools[0],progressText:'Elapsed 1m 1s · CPU 95.0%'},{...tool('read','completed'),settledAt:1000}]};
        expect(patchSubagentTools(dom,[second],[completed],document)).toBe(true);
        expect(waitNode.find('subagent-inline-tool')?.textContent).toContain('CPU 95.0%');
        jest.advanceTimersByTime(1999); expect(entry.children[0]).toBe(waitNode); expect(entry.children).toHaveLength(2);
        jest.advanceTimersByTime(1); expect(entry.children).toEqual([waitNode]);
        expect(patchSubagentTools(dom,[completed],[{...completed,latestText:'New text'}],document)).toBe(false);
        expect(patchSubagentTools(dom,[completed],[{...completed,state:'done'}],document)).toBe(false);
        expect(entry.children).toEqual([waitNode]);
    } finally {jest.useRealTimers();}
});
