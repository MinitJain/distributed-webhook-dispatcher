export type DispatchInput = {
  destinationUrl: string;
  eventId: string;
  payload: Record<string, unknown>;
};

export type ValidationResult =
  | { ok: true; value: DispatchInput }
  | { ok: false; error: string };

type Options = { allowPrivate?: boolean };

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const fail = (error: string): ValidationResult => ({ ok: false, error });

// Validates untrusted input from the public internet. Returns a result, never throws.
export function validateDispatch(body: unknown, opts: Options = {}): ValidationResult {
  if (!isObject(body)) return fail('body must be a JSON object');

  const { destinationUrl, eventId, payload } = body;

  if (typeof eventId !== 'string' || !eventId.trim() || eventId.length > 200)
    return fail('eventId must be a non-empty string (max 200 chars)');

  if (!isObject(payload)) return fail('payload must be a JSON object');

  if (typeof destinationUrl !== 'string') return fail('destinationUrl must be a string');

  let url: URL;
  try {
    url = new URL(destinationUrl);
  } catch {
    return fail('destinationUrl must be a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return fail('destinationUrl must be http or https');

  // SSRF guard: stops callers from aiming our server at internal addresses.
  if (!opts.allowPrivate && isPrivateHost(url.hostname))
    return fail('destinationUrl points to a private address');

  return { ok: true, value: { destinationUrl, eventId, payload } };
}

// Literal-address check only. It does not resolve DNS, so a public name that points at a
// private IP gets through. Known gap, see README.
export function isPrivateHost(h: string): boolean {
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.startsWith('[')) return /^\[(::1\]|f[cd]|fe80)/i.test(h);
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}
