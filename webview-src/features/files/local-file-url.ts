// A fragment survives HTML sanitization without granting file: navigation to the
// Webview. The existing local-file/image owner resolves it after sanitization.
export const LOCAL_FILE_FRAGMENT = '#oc-local-file=';

export function fileUrlPath(value: string): string | undefined {
  if (!/^file:/i.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.hostname && url.hostname !== 'localhost') return undefined;
    const path = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1');
    return path && !/[\u0000-\u001f\u007f]/.test(path) ? path : undefined;
  } catch { return undefined; }
}

export function installLocalFileUrls(markdown: { normalizeLink(value: string): string }): void {
  const normalize = markdown.normalizeLink.bind(markdown);
  markdown.normalizeLink = value => {
    const path = fileUrlPath(value) ?? (/^[a-z]:[\\/]/i.test(value) ? value.replace(/\\/g, '/') : undefined);
    return path === undefined ? normalize(value) : LOCAL_FILE_FRAGMENT + encodeURIComponent(path);
  };
}
