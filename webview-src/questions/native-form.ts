import type { NativeForm, FormValue } from '../../src/transport/protocol/V2InteractionAdapter';

type Answers = Record<string, FormValue>;
export function visibleFormAnswers(form: NativeForm, values: Answers): Answers {
    const result: Answers = Object.create(null);
    for (const field of form.fields) {
        const conditions = Array.isArray(field.when) ? field.when as { key: string; op: string; value: FormValue }[] : [];
        const active = conditions.every(condition => {
            const value = result[condition.key]; if (value === undefined) return false;
            const equal = Array.isArray(value) ? value.includes(condition.value) : value === condition.value;
            return condition.op === 'eq' ? equal : !equal;
        });
        const key = String(field.key), value = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : field.default;
        if (active && field.type !== 'external' && value !== undefined) result[key] = value as FormValue;
    }
    return result;
}
/** Uses the existing pinned question-card classes. Values never come from option labels. */
export function renderNativeForm(options: { document: Document; form: NativeForm; values: Answers; blocked: boolean; error?: string;
    owner: string; changed(): void; submit(response: 'answer' | 'reject', answer?: Answers): void }): HTMLElement {
    const { document, form, values } = options;
    const panel = document.createElement('div'); panel.className = 'question-panel';
    const card = document.createElement('form'); card.className = 'conflict-card question-card question-panel-card'; panel.appendChild(card);
    const heading = document.createElement('div'); heading.className = 'conflict-card-header'; heading.textContent = form.title; card.appendChild(heading);
    const owner = document.createElement('p'); owner.className = 'conflict-card-meta'; owner.textContent = options.owner; card.appendChild(owner);
    if (options.error) { const error = document.createElement('p'); error.textContent = options.error; card.appendChild(error); }
    const activeAnswers = visibleFormAnswers(form, values);
    for (const field of form.fields) {
        const key = String(field.key), conditions = Array.isArray(field.when) ? field.when as { key: string; op: string; value: FormValue }[] : [];
        const active = conditions.every(condition => {
            const value = activeAnswers[condition.key]; if (value === undefined) return false;
            const equal = Array.isArray(value) ? value.includes(condition.value) : value === condition.value;
            return condition.op === 'eq' ? equal : !equal;
        });
        if (!active || field.hidden === true) continue;
        const label = document.createElement('label'); label.className = 'question-card-question';
        label.textContent = String(field.title || key); label.style.display = 'block'; card.appendChild(label);
        if (field.description) { const description = document.createElement('p'); description.textContent = String(field.description); label.appendChild(description); }
        if (field.type === 'external') {
            try {
                const url = new URL(String(field.url));
                if (url.protocol === 'https:' || url.protocol === 'http:') {
                    const link = document.createElement('a'); link.textContent = url.href; link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; label.appendChild(link);
                }
            } catch { /* Never turn unrecognized external field schemes into clickable links. */ }
            continue;
        }
        const value = activeAnswers[key];
        let control: HTMLInputElement | HTMLSelectElement;
        if ((field.type === 'string' || field.type === 'multiselect') && Array.isArray(field.options) && field.custom !== true) {
            const select = document.createElement('select'); select.multiple = field.type === 'multiselect';
            if (!select.multiple) { const blank = document.createElement('option'); blank.value = ''; blank.textContent = 'Choose an option'; select.appendChild(blank); }
            for (const option of field.options as { value: string; label: string }[]) {
                const element = document.createElement('option'); element.value = option.value; element.textContent = option.label;
                element.selected = Array.isArray(value) ? value.includes(option.value) : value === option.value; select.appendChild(element);
            }
            select.addEventListener('change', () => { values[key] = select.multiple ? Array.from(select.selectedOptions).map(item => item.value) : select.value; options.changed(); });
            control = select;
        } else {
            const input = document.createElement('input'); input.type = field.type === 'boolean' ? 'checkbox' : field.type === 'integer' || field.type === 'number' ? 'number' : 'text';
            if (field.type === 'boolean') { input.checked = value === true; if (value === undefined) values[key] = false; }
            else input.value = value === undefined ? '' : Array.isArray(value) ? value.join(', ') : String(value);
            if (field.type === 'number') input.step = 'any';
            if (typeof field.minimum === 'number') input.min = String(field.minimum);
            if (typeof field.maximum === 'number') input.max = String(field.maximum);
            if (typeof field.minLength === 'number') input.minLength = field.minLength;
            if (typeof field.maxLength === 'number') input.maxLength = field.maxLength;
            if (typeof field.pattern === 'string') input.pattern = field.pattern;
            input.addEventListener('change', () => {
                if (input.type === 'checkbox') values[key] = input.checked;
                else if (input.type === 'number') { if (!input.value) delete values[key]; else values[key] = input.valueAsNumber; }
                else values[key] = field.type === 'multiselect' ? input.value.split(',').map(item => item.trim()).filter(Boolean) : input.value;
                options.changed();
            });
            control = input;
        }
        control.className = 'question-card-input'; control.disabled = options.blocked;
        control.required = field.required === true && field.type !== 'boolean'; label.appendChild(control);
    }
    const actions = document.createElement('div'); actions.className = 'question-card-actions'; card.appendChild(actions);
    const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'conflict-card-btn question-card-btn question-card-submit'; submit.textContent = 'Submit'; submit.disabled = options.blocked; actions.appendChild(submit);
    const reject = document.createElement('button'); reject.type = 'button'; reject.className = 'conflict-card-btn question-card-btn'; reject.textContent = 'Reject'; reject.disabled = options.blocked;
    reject.addEventListener('click', () => options.submit('reject')); actions.appendChild(reject);
    card.addEventListener('submit', event => { event.preventDefault(); if (!options.blocked && card.reportValidity()) options.submit('answer', visibleFormAnswers(form, values)); });
    return panel;
}
