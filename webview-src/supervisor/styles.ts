export const supervisorStyles = `
#supervisor-panel .sv-process{border-top:1px solid color-mix(in srgb,var(--vscode-foreground) 10%,transparent);padding-top:8px;margin:8px 0}
#supervisor-panel .sv-process strong{display:block;font-size:11px;margin-bottom:4px}
#supervisor-enable{display:inline-flex;align-items:center;gap:5px;flex-shrink:0;padding:3px 5px;border:0;border-radius:6px;background:transparent;color:var(--vscode-descriptionForeground);font:11px var(--vscode-font-family);cursor:pointer}
#supervisor-enable[hidden]{display:none}
#supervisor-enable::before{content:'';width:22px;height:12px;border-radius:8px;background:radial-gradient(circle at 6px 6px,currentColor 4px,transparent 4.5px),#8883}
#supervisor-enable[aria-checked=true]{color:var(--vscode-textLink-foreground)}
#supervisor-enable[aria-checked=true]::before{background:radial-gradient(circle at 16px 6px,currentColor 4px,transparent 4.5px),#378aff33}
#supervisor-enable:focus-visible{outline:2px solid var(--vscode-focusBorder)}
#supervisor-enable:disabled{opacity:.5;cursor:wait}
@media(max-width:420px){#supervisor-enable{font-size:0;gap:0;padding:3px}}
#supervisor-dock{position:relative;height:0;flex:0 0 0;margin:0 12px;z-index:9000}
#supervisor-dock #supervisor-toggle{position:absolute;top:auto;right:6px;bottom:62px}
#supervisor-dock #supervisor-panel{position:absolute;top:auto;right:0;bottom:106px;max-height:min(480px,50vh)}
#supervisor-toggle{--sv-accent:64,155,255;position:fixed;right:76px;top:42px;z-index:9000;width:36px;height:36px;box-sizing:border-box;border:1px solid rgba(var(--sv-accent),.35);border-radius:50%;background:rgba(var(--sv-accent),.18);color:rgb(var(--sv-accent));padding:0;font-size:0;cursor:pointer;backdrop-filter:blur(12px);opacity:.4;transition:opacity 160ms ease,background-color 160ms ease}
#supervisor-toggle::before{content:'';display:block;margin:auto;width:18px;height:18px;background:currentColor;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='m7 12 3 3 7-7' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/contain no-repeat}
#supervisor-toggle[data-tone=attention]{--sv-accent:235,170,65}
#supervisor-toggle[data-tone=error]{--sv-accent:240,100,100}
#supervisor-toggle[data-tone=unknown]{--sv-accent:155,165,180}
#supervisor-toggle:hover,#supervisor-toggle:focus-visible,#supervisor-toggle[aria-expanded=true]{opacity:1}
#supervisor-toggle:hover{background:rgba(var(--sv-accent),.3)}
@media (prefers-reduced-motion:reduce){#supervisor-toggle{transition:none}}
@media (forced-colors:active){#supervisor-toggle{opacity:1}}
#supervisor-toggle:focus-visible,#supervisor-panel summary:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}
#supervisor-panel{position:fixed;right:8px;top:80px;max-height:calc(100vh - 180px);width:min(380px,calc(100vw - 16px));overflow:auto;z-index:9001;box-sizing:border-box;padding:16px;border-radius:16px;border:1px solid rgba(90,155,230,.3);background:var(--vscode-editor-background);background:color-mix(in srgb,var(--vscode-editor-background) 58%,transparent);backdrop-filter:blur(12px);box-shadow:0 12px 36px #0004;color:var(--vscode-foreground);font:12px/1.5 var(--vscode-font-family);overflow-wrap:anywhere}
#supervisor-panel h3{font-size:15px;margin:0 0 8px;font-weight:600}
#supervisor-panel .sv-notice,#supervisor-panel .sv-activity,#supervisor-panel .sv-empty{color:var(--vscode-descriptionForeground);margin:8px 0;font-size:11px}
#supervisor-panel .sv-card{border:1px solid color-mix(in srgb,var(--vscode-foreground) 12%,transparent);background:color-mix(in srgb,var(--vscode-editor-background) 18%,transparent);border-radius:12px;padding:12px;margin-top:10px}
#supervisor-panel .sv-name{margin:0 0 8px;font-size:13px;font-weight:600;line-height:1.4}
#supervisor-panel .sv-badge{display:inline-block;border-radius:6px;padding:2px 7px;font-size:11px;font-weight:600;background:color-mix(in srgb,currentColor 10%,transparent)}
#supervisor-panel [data-tone=info]{color:var(--vscode-textLink-foreground,#3794ff)}
#supervisor-panel [data-tone=success]{color:var(--vscode-testing-iconPassed,#388a34)}
#supervisor-panel [data-tone=warning]{color:var(--vscode-editorWarning-foreground,#bf8803)}
#supervisor-panel [data-tone=danger]{color:var(--vscode-errorForeground,#f14c4c)}
#supervisor-panel [data-tone=muted]{color:var(--vscode-descriptionForeground)}
#supervisor-panel summary{cursor:pointer;font-size:11px;color:var(--vscode-descriptionForeground)}
#supervisor-panel .sv-history{margin-top:14px;border-top:1px solid var(--vscode-panel-border);padding-top:10px}
#supervisor-panel pre{font:11px/1.6 var(--vscode-editor-font-family);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--vscode-descriptionForeground);margin-bottom:0}
@media (forced-colors:active){#supervisor-toggle,#supervisor-panel,#supervisor-panel .sv-card{background:Canvas;border:1px solid CanvasText}#supervisor-panel .sv-badge{color:CanvasText;border:1px solid CanvasText}}
`;
