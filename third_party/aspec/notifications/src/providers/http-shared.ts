import { invalidConfig, NotificationProviderError } from '../errors.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function checkEndpoint(url: string, option: string, allowInsecure: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidConfig(option, 'must be an absolute URL');
  }
  if (parsed.protocol !== 'https:' && !(allowInsecure && parsed.protocol === 'http:')) {
    throw invalidConfig(option, 'must use https (set allowInsecureHttp for local development)');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw invalidConfig(option, 'must not contain credentials');
  }
  return parsed;
}

/** Classifies an HTTP status: 2xx ok, 408, 425, 429 and 5xx transient, other 4xx permanent. */
export function statusError(
  status: number,
  provider: string,
): NotificationProviderError | undefined {
  if (status >= 200 && status < 300) return undefined;
  const transient = status === 408 || status === 425 || status === 429 || status >= 500;
  const redirect = status >= 300 && status < 400;
  return new NotificationProviderError(
    redirect
      ? `${provider} endpoint answered with a redirect (${status}), which is not followed`
      : `${provider} endpoint answered ${status}`,
    {
      errorClass: transient ? 'transient' : 'permanent',
      providerCode: `HTTP_${status}`,
      responseCode: status,
    },
  );
}

/** POSTs JSON without following redirects, with a timeout, and discards the response body. */
export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal,
  provider: string,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      redirect: 'manual',
      signal: AbortSignal.any([signal, timeout]),
    });
  } catch (err) {
    const timedOut = timeout.aborted || (err instanceof Error && err.name === 'TimeoutError');
    throw new NotificationProviderError(
      timedOut
        ? `${provider} request timed out after ${timeoutMs} ms`
        : `${provider} request failed`,
      { errorClass: 'transient', providerCode: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', cause: err },
    );
  }
  const error = statusError(response.status, provider);
  await response.body?.cancel().catch(() => undefined);
  if (error) throw error;
  return response;
}
