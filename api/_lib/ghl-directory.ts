import {gatewayPage,readGatewayEnabled} from './kleegr-read.js';
// Server-only GHL reads. Smart Productivity owns OAuth refresh/persistence.
// The caller supplies a location from a verified tenant, never a browser query.
import { kleegrBaseUrl } from './kleegr.js';

export class DirectoryError extends Error {
  constructor(public code: string, message: string, public status = 502) {
    super(message);
    this.name = 'DirectoryError';
  }
}

export interface DirectoryPerson {
  id: string; name: string; email: string; phone: string; role: string;
}
export interface DirectoryContact {
  id: string; name: string; company: string; email: string; phone: string;
  assignedTo: string | null; createdAt: string | null; originalSource?:string; attributionFields?:Record<string,string>;
}
interface TokenRecord { accessToken: string; expiresAt: string; companyId?: string; locationId?: string }
interface Tokens { agency: TokenRecord | null; location: TokenRecord }
export const directoryConfigured = () => Boolean(process.env.KLEEGR_TOKEN_SERVICE_KEY?.trim());
const GHL = 'https://services.leadconnectorhq.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const str = (v: unknown) => typeof v === 'string' ? v.trim() : '';

export function normalizePerson(raw: any, locationId: string): DirectoryPerson | null {
  const id = str(raw?.id || raw?.ghlUserId || raw?.userId);
  if (!id) return null;
  const locations = raw?.roles?.locationIds ?? raw?.locationIds;
  // Explicit membership from GHL is authoritative; never import another location.
  if (Array.isArray(locations) && !locations.includes(locationId)) return null;
  if (raw?.locationId && raw.locationId !== locationId) return null;
  return { id, name: str(raw.name) || [str(raw.firstName), str(raw.lastName)].filter(Boolean).join(' ') || str(raw.email) || 'Unnamed user',
    email: str(raw.email).toLowerCase(), phone: str(raw.phone), role: str(raw.roles?.role || raw.role) || 'user' };
}

export function normalizeDirectoryContact(raw: any, locationId: string): DirectoryContact | null {
  const id = str(raw?.id);
  if (!id || (raw.locationId && raw.locationId !== locationId)) return null;
  return { id, name: str(raw.name) || str(raw.contactName) || [str(raw.firstName), str(raw.lastName)].filter(Boolean).join(' '),
    company: str(raw.companyName), email: str(raw.email).toLowerCase(), phone: str(raw.phone),
    assignedTo: str(raw.assignedTo) || null, createdAt: str(raw.dateAdded) || null, originalSource:str(raw.source)||undefined,
    attributionFields:Object.fromEntries((Array.isArray(raw.customFields)?raw.customFields:[]).filter((f:any)=>typeof f.id==='string'&&typeof f.value==='string'&&f.value.length<=500).map((f:any)=>[f.id,f.value])) };
}

async function jsonRequest(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<any> {
  let res: Response;
  try { res = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
  catch { throw new DirectoryError('upstream_unreachable', 'The data provider could not be reached. Please retry.'); }
  if (!res.ok) {
    // Never include response bodies: OAuth diagnostics can contain credentials.
    if (res.status === 401) throw new DirectoryError('token_rejected', 'GoHighLevel rejected the connection. Reconnect this sub-account in Smart Productivity.');
    if (res.status === 403) throw new DirectoryError('scope_required', 'The connected GHL app needs users.readonly and contacts.readonly access.');
    if (res.status === 429) throw new DirectoryError('rate_limited', 'GoHighLevel is busy. Please retry shortly.', 429);
    throw new DirectoryError('upstream_error', 'The data provider could not complete the request.');
  }
  try { return await res.json(); }
  catch { throw new DirectoryError('invalid_response', 'The data provider returned an invalid response.'); }
}

function usableToken(value: any): value is TokenRecord {
  return typeof value?.accessToken === 'string' && value.accessToken.length > 0
    && Number.isFinite(Date.parse(value.expiresAt)) && Date.parse(value.expiresAt) > Date.now() + 30000;
}

export async function resolveDirectoryTokens(locationId: string, fetchImpl: typeof fetch = fetch): Promise<Tokens> {
  if (readGatewayEnabled()) return {location:{accessToken:'gateway-managed',expiresAt:new Date(Date.now()+60000).toISOString(),locationId},agency:null};
  const key = process.env.KLEEGR_TOKEN_SERVICE_KEY?.trim();
  if (!key) throw new DirectoryError('token_service_not_configured', 'The Smart Productivity token connection is not configured.', 503);
  if (!locationId) throw new DirectoryError('location_required', 'Open this app from a connected Smart Productivity sub-account.', 409);
  const url = new URL('/api/auth/ghl/token-inspect', kleegrBaseUrl());
  if (url.protocol !== 'https:') throw new DirectoryError('insecure_token_service', 'The token service must use HTTPS.', 503);
  url.searchParams.set('locationId', locationId);
  const body = await jsonRequest(url.toString(), { headers: { 'x-service-key': key, accept: 'application/json' } }, fetchImpl);
  if (!usableToken(body.location)) throw new DirectoryError('reconnect_required', 'No fresh token is available for this sub-account. Reconnect the Marketplace app in Smart Productivity.', 409);
  if (body.location.locationId !== locationId) throw new DirectoryError('location_mismatch', 'The token service returned a different sub-account.', 502);
  const agency = usableToken(body.agency) && body.agency.companyId && body.agency.companyId === body.location.companyId ? body.agency : null;
  return { location: body.location, agency };
}

async function ghlRequest(path: string, token: string, body: unknown, fetchImpl: typeof fetch): Promise<any> {
  return jsonRequest(`${GHL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28', accept: 'application/json', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, fetchImpl);
}

export async function fetchDirectoryUsers(locationId: string, tokens: Tokens, fetchImpl: typeof fetch = fetch): Promise<DirectoryPerson[]> {
  const records = new Map<string, DirectoryPerson>();
  if(readGatewayEnabled()){for(let page=0;page<MAX_PAGES;page++){const result=await gatewayPage(locationId,'users',page*PAGE_SIZE,fetchImpl),payload=result.payload;if(!Array.isArray(payload.users))throw new DirectoryError('invalid_users','The gateway returned no user list.');let added=0;for(const raw of payload.users){const person=normalizePerson(raw,locationId);if(person){if(!records.has(person.id))added++;records.set(person.id,person);}}if(result.locationUsersFallback||result.rawCount<PAGE_SIZE||(Number.isFinite(payload.count)&&(page+1)*PAGE_SIZE>=payload.count))return [...records.values()];if(!added&&payload.users.length>0)throw new DirectoryError('pagination_stalled','User pagination did not advance.');}throw new DirectoryError('directory_too_large','The user list exceeds the sync limit.');}
  // Search Users is the paginated agency API. The location-token endpoint is
  // still supported for installations that have no agency-level token.
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ locationId });
    if (tokens.agency) {
      params.set('companyId', tokens.agency.companyId!);
      params.set('limit', String(PAGE_SIZE)); params.set('skip', String(page * PAGE_SIZE));
    }
    const payload = await ghlRequest(`${tokens.agency ? '/users/search' : '/users/'}?${params}`, (tokens.agency || tokens.location).accessToken, undefined, fetchImpl);
    if (!Array.isArray(payload.users)) throw new DirectoryError('invalid_users', 'GoHighLevel did not return a user list.');
    let added = 0;
    for (const raw of payload.users) { const person = normalizePerson(raw, locationId); if (person) { if (!records.has(person.id)) added++; records.set(person.id, person); } }
    if (!tokens.agency || payload.users.length < PAGE_SIZE || (Number.isFinite(payload.count) && (page + 1) * PAGE_SIZE >= payload.count)) return [...records.values()];
    if (!added) throw new DirectoryError('pagination_stalled', 'The user list could not be completely loaded. Please retry.');
  }
  throw new DirectoryError('directory_too_large', 'The user list exceeds the current sync limit. Contact your administrator.');
}

export async function fetchDirectoryContacts(locationId: string, tokens: Tokens, fetchImpl: typeof fetch = fetch): Promise<DirectoryContact[]> {
  const records = new Map<string, DirectoryContact>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const payload = readGatewayEnabled() ? (await gatewayPage(locationId,'contacts',(page-1)*PAGE_SIZE,fetchImpl)).payload : await ghlRequest('/contacts/search', tokens.location.accessToken, { locationId, page, pageLimit: PAGE_SIZE }, fetchImpl);
    if (!Array.isArray(payload.contacts)) throw new DirectoryError('invalid_contacts', 'GoHighLevel did not return a contact list.');
    let added = 0;
    for (const raw of payload.contacts) { const contact = normalizeDirectoryContact(raw, locationId); if (contact) { if (!records.has(contact.id)) added++; records.set(contact.id, contact); } }
    if (payload.contacts.length < PAGE_SIZE || (Number.isFinite(payload.total) && page * PAGE_SIZE >= payload.total)) return [...records.values()];
    if (!added) throw new DirectoryError('pagination_stalled', 'The contact list could not be completely loaded. Please retry.');
  }
  throw new DirectoryError('directory_too_large', 'The contact list exceeds the current sync limit. Contact your administrator.');
}
