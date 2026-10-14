/** Workspace acknowledgements own the flag; activity only locks its presentation. */
export function mountSupervisorSwitch(document: Document, send: (message: unknown) => void) {
    const anchor = document.querySelector('.variant-wrapper');
    if (!anchor?.parentNode) return;
    const button = document.createElement('button'); button.id = 'supervisor-enable'; button.type = 'button';
    button.textContent = 'Supervisor'; button.setAttribute('role', 'switch'); button.setAttribute('aria-checked', 'false');
    button.title = 'Enable task supervision'; button.hidden = true;
    anchor.parentNode.insertBefore(button, anchor.nextSibling);
    let enabled = false;
    let busy = false, pending = false;
    button.addEventListener('click', () => {
        if (button.disabled) return;
        pending = true; button.disabled = true;
        send({ type: 'setSupervisorEnabled', enabled: !enabled });
    });
    const update = (value: boolean, error?: string, acknowledged = true) => {
        enabled = value; if (acknowledged) pending = false; button.hidden = false; button.disabled = busy || pending;
        button.setAttribute('aria-checked', String(enabled));
        button.title = busy ? 'Supervisor settings are locked while tasks are running' : error || (enabled ? 'Disable task supervision' : 'Enable Supervisor and restart the idle GUI-owned OpenCode service');
    };
    return Object.assign(update, { setBusy(value: boolean) { busy = value; button.disabled = pending || busy;
        button.title = busy ? 'Supervisor settings are locked while tasks are running' : enabled ? 'Disable task supervision' : 'Enable Supervisor and restart the idle GUI-owned OpenCode service'; } });
}
