// Fetch abstraction and error type. The extension implements Http with
// same-origin fetch; tests implement it with fixtures.

export type ErrorCode = 'not_logged_in' | 'not_found' | 'rate_limited' | 'network' | 'not_a_chat' | 'unknown';

export class ExportError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status = 0,
  ) {
    super(message);
    this.name = 'ExportError';
  }
}

export function errorForStatus(status: number, url: string): ExportError {
  if (status === 401 || status === 403) return new ExportError('not_logged_in', `HTTP ${status} for ${url}`, status);
  if (status === 404) return new ExportError('not_found', `HTTP ${status} for ${url}`, status);
  if (status === 429) return new ExportError('rate_limited', `HTTP ${status} for ${url}`, status);
  return new ExportError('unknown', `HTTP ${status} for ${url}`, status);
}

export interface Http {
  /** GET a same-origin path and parse JSON. Throws ExportError on failure. */
  getJson(path: string, headers?: Record<string, string>): Promise<any>;
  /** POST JSON to a same-origin path and parse JSON. Throws ExportError on failure. */
  postJson(path: string, body: unknown, headers?: Record<string, string>): Promise<any>;
  /** GET a same-origin path as raw bytes (files, images). Throws ExportError on failure. */
  getBytes(path: string): Promise<Uint8Array>;
}

/** Http on top of a fetch function (the content script passes window.fetch). */
export function fetchHttp(fetchFn: typeof fetch): Http {
  const run = async (path: string, init: RequestInit) => {
    let res: Response;
    try {
      res = await fetchFn(path, { credentials: 'include', ...init });
    } catch (e) {
      throw new ExportError('network', `Network error for ${path}: ${(e as Error).message}`);
    }
    if (!res.ok) throw errorForStatus(res.status, path);
    try {
      return await res.json();
    } catch {
      throw new ExportError('unknown', `Invalid JSON from ${path}`, res.status);
    }
  };
  const bytes = async (path: string) => {
    let res: Response;
    try {
      res = await fetchFn(path, { credentials: 'include', method: 'GET' });
    } catch (e) {
      throw new ExportError('network', `Network error for ${path}: ${(e as Error).message}`);
    }
    if (!res.ok) throw errorForStatus(res.status, path);
    try {
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      throw new ExportError('network', `Download interrupted for ${path}: ${(e as Error).message}`);
    }
  };
  return {
    getBytes: bytes,
    getJson: (path, headers) => run(path, { method: 'GET', headers }),
    postJson: (path, body, headers) =>
      run(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
  };
}
