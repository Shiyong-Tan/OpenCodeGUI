type SmartSearchStateLike = {
  query: string;
  smartInFlight: boolean;
  setEmptySmartResults(): void;
  beginSmartSearch(requestId: string): boolean;
};

export function createSmartSearchRequestController(options: {
  state: SmartSearchStateLike;
  clearHighlights(): void;
  updateControls(): void;
  collectMessages(): Array<{ id: string; role: string; text: string }>;
  getSessionId(): string;
  postMessage(message: unknown): void;
  createRequestId(): string;
}) {
  const run = (): boolean => {
    const query = String(options.state.query || '').trim();
    if (!query || options.state.smartInFlight) return false;
    const messages = options.collectMessages();
    if (!messages.length) {
      options.clearHighlights();
      options.state.setEmptySmartResults();
      options.updateControls();
      return false;
    }
    const requestId = options.createRequestId();
    if (!options.state.beginSmartSearch(requestId)) return false;
    options.clearHighlights();
    options.updateControls();
    options.postMessage({
      type: 'smartSessionSearch',
      requestId,
      sessionId: options.getSessionId() || '',
      query,
      messages,
    });
    return true;
  };
  return { run };
}
