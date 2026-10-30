const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('async function callAuthFunction(');
const end = html.indexOf('\nfunction showAuthForm(', start);
assert(start >= 0 && end > start);
let called = [];
let rpcResult = { data: { success: true, status: 'waiting', matchId: 'test' }, error: null };
const context = { console, sb: { rpc: async (...args) => { called.push(args); return rpcResult; } },
  FUNCTIONS_URL: 'https://example.test/functions/v1', SUPABASE_KEY: 'key',
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }) };
vm.createContext(context);
vm.runInContext(html.slice(start, end), context);
(async () => {
  const body = { action: 'random', userId: 'test' };
  let res = await context.callAuthFunction('match-join', body);
  assert.equal(res.ok, true); assert.equal(called[0][0], 'bazaar_match_join'); assert.deepEqual(called[0][1].body, body);
  rpcResult = { data: { error: 'دعوت معتبر نیست' }, error: null };
  res = await context.callAuthFunction('match-join', body); assert.equal(res.ok, false); assert.equal(res.data.error, 'دعوت معتبر نیست');
  rpcResult = { data: { success: true, advanced: true }, error: null };
  res = await context.callAuthFunction('match-next-day', { action: 'ready' }); assert.equal(res.ok, true); assert.equal(called[2][0], 'bazaar_match_turn');
  res = await context.callAuthFunction('auth-login', {}); assert.equal(res.ok, true);
  rpcResult = { data: null, error: { message: 'offline' } }; res = await context.callAuthFunction('match-join', body); assert.equal(res.ok, false);
  console.log('multiplayer client routing: OK');
})().catch(e => { console.error(e); process.exitCode = 1; });
