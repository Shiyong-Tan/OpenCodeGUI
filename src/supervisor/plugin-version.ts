/** Release numbers are metadata; schema and authenticated handshake gate compatibility. */
export function isPluginVersion(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 100 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}
