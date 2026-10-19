/* ── The one door to the server (spec 11.1, 13.1) ─────────────────────────────
 * Every request the composer makes goes through these three:
 *   api(method, path, body?)   JSON in, JSON out, same-origin cookie. A failed
 *                              answer throws ApiError carrying the server's
 *                              `{ error, message }` (the key is what code
 *                              branches on, the message what a person reads).
 *                              A 401 means the session ended: back to /login,
 *                              then here again.
 *   uploadImage(file, onPct)   multipart `image` with upload progress; the
 *                              server mints the key (spec 10.5), the client
 *                              never names one
 *   imgUrl(key, variant)       the gated image path
 * Every request is JSON (the server refuses anything else on /api, 415), and
 * the browser's own Origin header is what the CSRF check reads.
 */
import { t } from './strings.ts';
import type { Uploaded } from './types.ts';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function toLogin(): void {
  const here = location.pathname + location.search;
  location.assign(`/login?next=${encodeURIComponent(here)}`);
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', t('common.offline'));
  }
  const data = await res.json().catch(() => null) as (T & { error?: string; message?: string }) | null;
  if (res.ok) return (data ?? {}) as T;
  const code = data?.error || 'server_error';
  if (res.status === 401 && code === 'not_signed_in') toLogin();
  throw new ApiError(res.status, code, data?.message || t('common.didnt_work'));
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const put = <T>(path: string, body: unknown) => api<T>('PUT', path, body);
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const del = <T>(path: string, body?: unknown) => api<T>('DELETE', path, body);

export const enc = encodeURIComponent;

/** The words to show for a failure: the server's message, else a plain one. */
export const errorText = (e: unknown): string => (e instanceof Error && e.message ? e.message : t('common.didnt_work'));

export function imgUrl(key: string, variant: 'web' | 'thumb' = 'web'): string {
  return key ? `/api/images/${enc(key)}/${variant}` : '';
}

/** Upload one image through the door; resolves with the server's key. */
export function uploadImage(file: File, onPct: (pct: number) => void = () => {}): Promise<Uploaded> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/images');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onPct(Math.round((e.loaded / e.total) * 100)); };
    xhr.onerror = () => reject(new ApiError(0, 'network', t('common.offline')));
    xhr.onload = () => {
      const data = (xhr.response || {}) as Uploaded & { error?: string; message?: string };
      if (xhr.status === 201) return resolve(data);
      if (xhr.status === 401) toLogin();
      reject(new ApiError(xhr.status, data.error || 'image_failed', data.message || t('compose.upload_failed')));
    };
    const fd = new FormData();
    fd.append('image', file);
    xhr.send(fd);
  });
}

/** Copy to the clipboard; false when the browser refuses (the text stays on screen). */
export async function copyText(text: string): Promise<boolean> {
  // A browser that holds the write on a permission prompt answers within 2 s or
  // counts as a refusal: the notice must not wait on it.
  const late = new Promise<boolean>((res) => { setTimeout(() => res(false), 2000); });
  const write = navigator.clipboard ? navigator.clipboard.writeText(text).then(() => true, () => false) : Promise.resolve(false);
  return Promise.race([write, late]);
}
