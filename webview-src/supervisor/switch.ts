/** The switch reflects configuration acknowledgements; it never starts/stops a service. */
export function mountSupervisorSwitch(document: Document, send: (message: unknown) => void) {
    const anchor = document.querySelector('.variant-wrapper');
    if (!anchor?.parentNode) return;
    const button = document.createElement('button'); button.id = 'supervisor-enable'; button.type = 'button';
    button.textContent = 'Supervisor'; button.setAttribute('role', 'switch'); button.setAttribute('aria-checked', 'false');
    button.title = 'Enable task supervision'; button.hidden = true;
    anchor.parentNode.insertBefore(button, anchor.nextSibling);
    let enabled = false;
    button.addEventListener('click', () => {
        if (button.disabled) return;
        button.disabled = true;
        send({ type: 'setSupervisorEnabled', enabled: !enabled });
    });
    return (value: boolean, error?: string) => {
        enabled = value; button.hidden = false; button.disabled = false;
        button.setAttribute('aria-checked', String(enabled));
        button.title = error || (enabled ? 'Disable GUI supervision; running tasks continue' : 'Enable task supervision');
    };
}
