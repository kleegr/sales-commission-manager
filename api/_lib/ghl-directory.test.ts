import assert from 'node:assert/strict';
import { resolveDirectoryTokens, fetchDirectoryUsers, fetchDirectoryContacts, normalizePerson, DirectoryError } from './ghl-directory.js';

const savedKey = process.env.KLEEGR_TOKEN_SERVICE_KEY;
const savedBase = process.env.KLEEGR_API_BASE_URL;
const expiresAt = new Date(Date.now() + 3600000).toISOString();
const tokens = { location: { accessToken: 'location-test', locationId: 'loc-a', companyId: 'co-a', expiresAt }, agency: { accessToken: 'agency-test', companyId: 'co-a', expiresAt } };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fake = (fn: (url: string, init?: RequestInit) => Response | Promise<Response>) => fn as typeof fetch;
let passed = 0;
async function check(name: string, test: () => unknown) { await test(); passed++; console.log(`  ✓ ${name}`); }
try {
  process.env.KLEEGR_API_BASE_URL = 'https://smart-productivity-pied.vercel.app';
  delete process.env.KLEEGR_TOKEN_SERVICE_KEY;
  await check('missing service key fails before making a request', () => assert.rejects(resolveDirectoryTokens('loc-a', fake(() => { throw new Error('must not fetch'); })), {code:'token_service_not_configured'}));
  process.env.KLEEGR_TOKEN_SERVICE_KEY = 'service-test';
  await check('server key sent only to the configured service with requested location', async () => {
    const result = await resolveDirectoryTokens('loc-a', fake((url, init) => { assert.equal(new URL(url).searchParams.get('locationId'), 'loc-a'); assert.equal(new Headers(init?.headers).get('x-service-key'),'service-test'); assert.equal(init?.redirect,'error'); return reply(tokens); }));
    assert.equal(result.location.accessToken, tokens.location.accessToken);
  });
  await check('wrong location is rejected', () => assert.rejects(resolveDirectoryTokens('loc-b', fake(() => reply(tokens))), {code:'location_mismatch'}));
  await check('expired tokens require reconnect', () => assert.rejects(resolveDirectoryTokens('loc-a', fake(() => reply({...tokens,location:{...tokens.location,expiresAt:'2000-01-01'}}))), {code:'reconnect_required'}));
  await check('different-company agency token is excluded', async () => assert.equal((await resolveDirectoryTokens('loc-a', fake(() => reply({...tokens,agency:{...tokens.agency,companyId:'co-b'}})))).agency,null));
  await check('provider error bodies and secrets never enter errors', async () => {
    await assert.rejects(resolveDirectoryTokens('loc-a', fake(() => reply({accessToken:'DO-NOT-EXPOSE'},401))), e => e instanceof DirectoryError && !e.message.includes('DO-NOT-EXPOSE'));
  });
  await check('explicit membership excludes other locations', () => { assert.equal(normalizePerson({id:'u',roles:{locationIds:['loc-b']}},'loc-a'),null); assert.equal(normalizePerson({id:'u',locationId:'loc-b'},'loc-a'),null); });
  await check('all user pages load and external IDs deduplicate', async () => {
    let calls = 0;
    const result = await fetchDirectoryUsers('loc-a',tokens,fake((url,init) => {
      const p = new URL(url); assert.equal(p.searchParams.get('companyId'),'co-a'); assert.equal(p.searchParams.get('locationId'),'loc-a');
      assert.equal(new Headers(init?.headers).get('authorization'),'Bearer agency-test'); assert.equal(p.searchParams.get('skip'),String(calls*100));
      return reply({count:102,users: calls++ === 0 ? Array.from({length:100},(_,i)=>({id:`u${i}`,roles:{locationIds:['loc-a']}})) : [{id:'u99'},{id:'u100'}]});
    })); assert.equal(calls,2); assert.equal(result.length,101);
  });
  await check('contacts paginate beyond the old fifty-record cap and filter mismatches', async () => {
    let calls=0;
    const result=await fetchDirectoryContacts('loc-a',tokens,fake((url,init)=>{assert.ok(url.endsWith('/contacts/search'));const body=JSON.parse(String(init?.body)); assert.equal(body.page,++calls);assert.equal(body.locationId,'loc-a');return reply({contacts:calls===1?Array.from({length:100},(_,i)=>({id:`c${i}`,locationId:'loc-a'})):[{id:'c100',locationId:'loc-a'},{id:'foreign',locationId:'loc-b'}]});}));
    assert.equal(result.length,101);assert.equal(calls,2);
  });
  await check('repeated full page is an error instead of partial success', ()=>assert.rejects(fetchDirectoryContacts('loc-a',tokens,fake(()=>reply({contacts:Array.from({length:100},(_,i)=>({id:`c${i}`}))}))),{code:'pagination_stalled'}));
  await check('failure after page one never returns incomplete records', async ()=> {let calls=0;await assert.rejects(fetchDirectoryContacts('loc-a',tokens,fake(()=>++calls===1?reply({contacts:Array.from({length:100},(_,i)=>({id:`c${i}`}))}):reply({},429))),{code:'rate_limited'});});
  await check('invalid resource response is rejected', ()=>assert.rejects(fetchDirectoryUsers('loc-a',tokens,fake(()=>reply({}))),{code:'invalid_users'}));
  console.log(`\n${passed} directory checks passed`);
} finally {
  if(savedKey===undefined)delete process.env.KLEEGR_TOKEN_SERVICE_KEY;else process.env.KLEEGR_TOKEN_SERVICE_KEY=savedKey;
  if(savedBase===undefined)delete process.env.KLEEGR_API_BASE_URL;else process.env.KLEEGR_API_BASE_URL=savedBase;
}
