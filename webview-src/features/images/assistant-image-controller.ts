export interface AssistantImageResolution {
  readonly id: string;
  readonly path: string;
  readonly resolvedPath?: string;
  readonly uri?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface AssistantImageResolutionMessage {
  readonly type: 'assistantImageReferencesResolved';
  readonly requestId: string;
  readonly items?: readonly AssistantImageResolution[];
}

export interface AssistantImageControllerDependencies {
  readonly document: Document;
  readonly postMessage: (message: unknown) => unknown;
  readonly createRequestId?: () => string;
}

export interface AssistantImageController {
  enhance(root: HTMLElement): void;
  acceptResponse(message: AssistantImageResolutionMessage): boolean;
}

interface PendingReference {
  readonly id: string;
  readonly path: string;
  readonly contextPath?: string;
  readonly element: HTMLAnchorElement | HTMLImageElement;
  readonly mode: 'link' | 'inline';
}

const MAX_RESOLUTION_CACHE_ENTRIES = 256;

const IMAGE_PATH_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg|tiff?|ico|heic)(?:[?#].*)?$/i;
const LOCAL_PATH_RE = /^(?:[a-z]:[\\/]|\.{1,3}[\\/]|[^:/?#]+[\\/])/i;

export function isAssistantImagePath(value: unknown): value is string {
  return typeof value === 'string' && IMAGE_PATH_RE.test(value.trim());
}

export function decodeLocalReference(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^ocfile:\/\/open/i.test(raw)) {
    try {
      return new URL(raw).searchParams.get('path') || '';
    } catch {
      return '';
    }
  }
  if (/^file:/i.test(raw)) {
    try {
      return decodeURIComponent(new URL(raw).pathname).replace(/^\/([a-z]:\/)/i, '$1');
    } catch {
      return '';
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function createAssistantImageController(
  dependencies: AssistantImageControllerDependencies,
): AssistantImageController {
  let sequence = 0;
  const pending = new Map<string, PendingReference[]>();
  // Virtualized rows are routinely destroyed and recreated while scrolling.
  // Keep successful resolutions for the lifetime of this Webview so a
  // remounted image row can reserve and render its preview synchronously,
  // instead of briefly measuring as a text-only row and growing later.
  const resolutionCache = new Map<string, AssistantImageResolution>();
  const createRequestId = dependencies.createRequestId
    || (() => `assistant-image-${Date.now()}-${++sequence}`);

  const openHref = (filePath: string, contextPath?: string): string => {
    const context = contextPath ? `&contextPath=${encodeURIComponent(contextPath)}` : '';
    return `ocfile://open?path=${encodeURIComponent(filePath)}${context}`;
  };

  const cacheKey = (filePath: string, contextPath?: string): string =>
    `${contextPath || ''}\u0000${filePath}`;

  const cacheResolution = (
    reference: Pick<PendingReference, 'path' | 'contextPath'>,
    resolution: AssistantImageResolution,
  ): void => {
    const key = cacheKey(reference.path, reference.contextPath);
    resolutionCache.delete(key);
    resolutionCache.set(key, resolution);
    if (resolutionCache.size > MAX_RESOLUTION_CACHE_ENTRIES) {
      const oldest = resolutionCache.keys().next().value;
      if (typeof oldest === 'string') resolutionCache.delete(oldest);
    }
  };

  const applyResolution = (
    reference: PendingReference,
    resolved: AssistantImageResolution | undefined,
  ): void => {
    const element = reference.element;
    if (!element.isConnected) return;
    if (!resolved?.resolvedPath || !resolved.uri) {
      element.classList.remove('is-loading');
      element.classList.add('is-unresolved');
      return;
    }
    const href = openHref(resolved.resolvedPath);
    if (reference.mode === 'inline' && element instanceof HTMLImageElement) {
      element.dataset.ocResolvedPath = resolved.resolvedPath;
      if (resolved.width && resolved.height) {
        element.width = resolved.width;
        element.height = resolved.height;
      }
      element.src = resolved.uri;
      element.loading = 'lazy';
      element.alt ||= resolved.path;
      element.classList.remove('is-loading');
      element.setAttribute('title', `Open ${resolved.resolvedPath}`);
      return;
    }
    if (!(element instanceof HTMLAnchorElement) || !element.parentNode) return;
    element.href = href;
    if (element.nextElementSibling?.classList.contains('assistant-image-thumbnail')) return;
    const preview = dependencies.document.createElement('a');
    preview.className = 'assistant-image-thumbnail';
    preview.href = href;
    preview.setAttribute('aria-label', `Preview ${resolved.path}`);
    preview.setAttribute('title', `Open ${resolved.resolvedPath}`);
    const image = dependencies.document.createElement('img');
    if (resolved.width && resolved.height) {
      image.width = resolved.width;
      image.height = resolved.height;
    }
    image.src = resolved.uri;
    image.alt = resolved.path;
    image.loading = 'lazy';
    preview.appendChild(image);
    let insertionAnchor: Element = element;
    const visibleLabel = (element.textContent || '').trim();
    const hidesRawPath = visibleLabel === reference.path
      || decodeLocalReference(visibleLabel) === reference.path;
    if (hidesRawPath) {
      element.classList.add('assistant-image-path-hidden');
      const code = element.parentElement?.tagName.toLowerCase() === 'code'
        ? element.parentElement
        : null;
      if (code && (code.textContent || '').trim() === visibleLabel) {
        code.classList.add('assistant-image-path-hidden');
        insertionAnchor = code;
      }
    }
    insertionAnchor.parentNode?.insertBefore(preview, insertionAnchor.nextSibling);
  };

  const extractElementPath = (element: Element): string => {
    if (element instanceof HTMLImageElement) {
      return decodeLocalReference(element.getAttribute('src') || element.dataset.ocImagePath || '');
    }
    if (element instanceof HTMLAnchorElement) {
      return decodeLocalReference(element.getAttribute('href') || '');
    }
    return '';
  };

  function enhance(root: HTMLElement): void {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    const references: PendingReference[] = [];
    let contextPath = '';
    for (const element of Array.from(root.querySelectorAll<HTMLAnchorElement | HTMLImageElement>('a, img'))) {
      const rawPath = extractElementPath(element);
      if (!rawPath) continue;
      const localPath = rawPath.replace(/[?#].*$/, '');
      const imagePath = isAssistantImagePath(localPath);
      const isLocal = LOCAL_PATH_RE.test(localPath) || imagePath;
      if (!isLocal) continue;
      const abbreviated = /^\.{3}[\\/]/.test(localPath);
      const referenceContext = abbreviated && contextPath ? contextPath : undefined;
      if (!abbreviated) contextPath = localPath;
      if (!imagePath) {
        // Markdown can already contain a relative workspace link. The generic
        // text linkifier intentionally skips existing anchors, so normalize
        // those links here as well; otherwise they look clickable but attempt
        // an unsupported webview navigation instead of opening in the editor.
        if (element instanceof HTMLAnchorElement) {
          element.href = openHref(localPath, referenceContext);
          element.classList.add('oc-file-link');
        }
        continue;
      }
      if (element.dataset.ocImageRequested === '1') continue;

      const id = `image-${references.length + 1}`;
      element.dataset.ocImageRequested = '1';
      if (element instanceof HTMLImageElement) {
        element.dataset.ocImagePath = localPath;
        element.removeAttribute('src');
        element.classList.add('assistant-image-inline', 'is-loading');
        element.tabIndex = 0;
        element.setAttribute('role', 'button');
        element.setAttribute('title', `Open ${localPath}`);
        element.addEventListener('click', () => {
          const resolvedPath = element.dataset.ocResolvedPath;
          dependencies.postMessage({
            type: 'openFileAtLocation',
            path: resolvedPath || localPath,
            ...(resolvedPath || !referenceContext ? {} : { contextPath: referenceContext }),
          });
        });
      } else {
        element.href = openHref(localPath, referenceContext);
        element.classList.add('assistant-image-link');
      }
      const reference: PendingReference = {
        id,
        path: localPath,
        contextPath: referenceContext,
        element,
        mode: element instanceof HTMLImageElement ? 'inline' : 'link',
      };
      const cached = resolutionCache.get(cacheKey(localPath, referenceContext));
      if (cached) {
        // Applying here is intentionally synchronous with row enhancement.
        // TanStack's first measurement therefore sees the final image box.
        applyResolution(reference, cached);
      } else {
        references.push(reference);
      }
    }
    if (references.length === 0) return;
    const requestId = createRequestId();
    pending.set(requestId, references);
    dependencies.postMessage({
      type: 'resolveAssistantImageReferences',
      requestId,
      references: references.map(({ id, path, contextPath }) => ({ id, path, contextPath })),
    });
  }

  function acceptResponse(message: AssistantImageResolutionMessage): boolean {
    if (message?.type !== 'assistantImageReferencesResolved' || !message.requestId) return false;
    const references = pending.get(message.requestId);
    if (!references) return false;
    pending.delete(message.requestId);
    const resolvedById = new Map((message.items || []).map((item) => [item.id, item]));
    for (const reference of references) {
      const resolved = resolvedById.get(reference.id);
      if (resolved?.resolvedPath && resolved.uri) cacheResolution(reference, resolved);
      applyResolution(reference, resolved);
    }
    return true;
  }

  return Object.freeze({ enhance, acceptResponse });
}
