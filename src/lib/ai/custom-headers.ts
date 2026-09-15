/**
 * Parses user-provided custom HTTP headers string (JSON or "Header-Key: Value" lines)
 * into a Record<string, string> dictionary.
 */
export function parseCustomHeaders(raw: unknown): Record<string, string> {
  if (!raw) return {};
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, string>;
  }
  if (typeof raw !== 'string') return {};

  const trimmed = raw.trim();
  if (!trimmed) return {};

  // If input looks like JSON object, try parsing JSON first
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const result: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (key && value !== undefined && value !== null) {
            result[String(key).trim()] = String(value).trim();
          }
        }
        return result;
      }
    } catch {
      // Fallback to line-by-line parsing if JSON syntax is malformed
    }
  }

  // Parse multi-line "Header-Name: Header-Value" format
  const result: Record<string, string> = {};
  const lines = trimmed.split(/\r?\n/);
  for (const line of lines) {
    const l = line.trim();
    if (!l || l.startsWith('#') || l.startsWith('//')) continue;
    const colonIdx = l.indexOf(':');
    if (colonIdx > 0) {
      const headerName = l.slice(0, colonIdx).trim();
      const headerValue = l.slice(colonIdx + 1).trim();
      if (headerName) {
        result[headerName] = headerValue;
      }
    }
  }

  return result;
}
