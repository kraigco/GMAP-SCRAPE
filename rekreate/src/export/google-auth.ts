import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * Service-account auth for Sheets, with no dependency beyond node:crypto.
 *
 * An API key cannot write to Sheets — the API rejects it with
 * "API keys are not supported by this API. Expected OAuth2 access token or
 * other authentication credentials that assert a principal." A write has to be
 * attributable to someone whose permissions can be checked against the
 * document's sharing list, and a key names no one.
 *
 * So: sign a JWT with the service account's private key, exchange it at
 * Google's token endpoint for an access token, call Sheets with that.
 */

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  project_id?: string;
};

export async function loadServiceAccount(path: string): Promise<ServiceAccountKey> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(
      `No service-account key at ${path}. Download one from ` +
        `IAM & Admin > Service Accounts > (your account) > Keys > Add key > JSON.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }

  const key = parsed as Partial<ServiceAccountKey>;
  if (typeof key.client_email !== 'string' || typeof key.private_key !== 'string') {
    throw new Error(
      `${path} has no client_email/private_key. That usually means it is an OAuth ` +
        `client secret rather than a service-account key — they are different downloads.`,
    );
  }
  return key as ServiceAccountKey;
}

function b64url(input: string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * `nowSeconds` is injected rather than read from the clock, so the assertion
 * builder stays testable with a fixed timestamp.
 */
export function buildAssertion(key: ServiceAccountKey, scope: string, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope,
      aud: TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .end()
    .sign(key.private_key)
    .toString('base64url');

  return `${signingInput}.${signature}`;
}

export async function getAccessToken(
  key: ServiceAccountKey,
  scope: string = SHEETS_SCOPE,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: buildAssertion(key, scope, nowSeconds),
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${body}`);
  }

  const token = (JSON.parse(body) as { access_token?: string }).access_token;
  if (!token) throw new Error(`Token exchange returned no access_token: ${body}`);
  return token;
}
