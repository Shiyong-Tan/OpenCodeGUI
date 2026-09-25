export const supervisorStyles = `
#supervisor-dock{position:relative;height:0;flex:0 0 0;margin:0 12px;z-index:9000}
#supervisor-dock #supervisor-toggle{position:absolute;top:auto;right:0;bottom:0}
#supervisor-dock #supervisor-panel{position:absolute;top:auto;right:0;bottom:38px;max-height:min(480px,50vh)}
#supervisor-toggle{position:fixed;right:12px;top:42px;z-index:9000;border:1px solid rgba(64,155,255,.35);border-radius:999px;background:rgba(38,120,220,.18);color:var(--vscode-foreground);padding:6px 12px;font:500 12px var(--vscode-font-family);cursor:pointer;backdrop-filter:blur(12px)}
#supervisor-toggle{opacity:.4;transition:opacity 160ms ease,background-color 160ms ease}
#supervisor-toggle:hover,#supervisor-toggle:focus-visible,#supervisor-toggle[aria-expanded=true]{opacity:1}
#supervisor-toggle:hover{background:rgba(38,120,220,.3)}
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
