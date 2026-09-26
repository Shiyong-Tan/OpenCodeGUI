export interface ReviewQuestion {
    title: string; prompt: string; options: { id: string; label: string; description: string }[]; multiple: boolean; custom: boolean;
}
export function parseReviewQuestions(value: unknown): ReviewQuestion[] {
    if (!Array.isArray(value) || !value.length || value.length > 32) throw new Error('Invalid question list');
    const text = (v: unknown, max: number) => { if (typeof v !== 'string' || v.length > max) throw new Error('Invalid question text'); return v; };
    return value.map(q => {
        if (!q || !Array.isArray(q.options) || q.options.length > 128) throw new Error('Invalid question options');
        return { title: text(q.header ?? '', 500), prompt: text(q.question, 16000), multiple: q.multiple === true, custom: q.custom !== false,
            options: q.options.map((o: { label?: unknown; description?: unknown }) => {
                const label = text(o?.label, 1000); return { id: label, label, description: text(o?.description ?? '', 4000) };
            }) };
    });
}
export function validateQuestionAnswers(questions: ReviewQuestion[], value: unknown): asserts value is string[][] {
    if (!Array.isArray(value) || value.length !== questions.length) throw new Error('Answer every question before submitting');
    value.forEach((answer, i) => {
        const q = questions[i];
        if (!Array.isArray(answer) || !answer.length || answer.length > 128 || (!q.multiple && answer.length !== 1) ||
            answer.some(a => typeof a !== 'string' || !a.trim() || a.length > 16000 || (!q.custom && !q.options.some(o => o.label === a))))
            throw new Error('Invalid question answer');
    });
}
