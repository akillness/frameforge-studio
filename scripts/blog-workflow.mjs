#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const accountIds = new Set(['naver-banggujin', 'naver-jelly_ggumi', 'naver-jennie_p', 'tistory', 'github-jellyggumi']);
const operations = new Set(['status', 'refresh', 'tick', 'login', 'deploy-plan', 'deploy']);
const help = `FrameForge blog workflow (authenticated same-origin API; no shell commands)
  node scripts/blog-workflow.mjs status
  node scripts/blog-workflow.mjs refresh
  node scripts/blog-workflow.mjs tick
  node scripts/blog-workflow.mjs login --account <account-id> --version <version>
  node scripts/blog-workflow.mjs deploy-plan --draft <draft-id> --version <version>
  node scripts/blog-workflow.mjs deploy --draft <draft-id> --version <version> --approval <approval-id> [--git-consent <plan-hash>]
  node scripts/blog-workflow.mjs request --operation <status|refresh|tick|login|deploy-plan|deploy> [operation flags]
  node scripts/blog-workflow.mjs cron

Set BLOG_API_ORIGIN (default http://127.0.0.1:4310) and either BLOG_API_SESSION
(the frameforge_session value) or LOGIN_TOKEN in the invoking process. Credentials
are never accepted as command arguments, printed or exported. 'request' exports
only an inert JSON API request for review; it does not authenticate or execute.
'login' verifies the selected platform account through its established host script;
manual login/MFA may still be required. It never accepts a platform password.
'deploy' requires the exact current draft/version owner approval; uncertain targets
and unavailable publisher/readback adapters fail closed and are not retried.
GitHub additionally requires viewing the exact deploy-plan and explicitly passing
--git-consent with that plan hash to authorize its exact local commit and push.
`;

export function buildBlogRequest(argv) {
  const [command = 'help', ...args] = argv;
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--operation', '--account', '--draft', '--version', '--approval', '--git-consent'].includes(key) || !args[index + 1] || args[index + 1].startsWith('--') || options[key] !== undefined) throw new Error('Use only documented explicit blog workflow arguments.');
    options[key] = args[index + 1];
  }
  if (['help', '--help', '-h', 'cron'].includes(command)) { if (args.length) throw new Error('Unexpected arguments.'); return { command }; }
  const operation = command === 'request' ? options['--operation'] : command;
  if (!operations.has(operation)) throw new Error('Unknown blog workflow operation; use --help.');
  const allowed = operation === 'login' ? ['--account', '--version'] : operation === 'deploy' ? ['--draft', '--version', '--approval', '--git-consent'] : operation === 'deploy-plan' ? ['--draft', '--version'] : [];
  if (command === 'request') allowed.push('--operation');
  if (Object.keys(options).some(key => !allowed.includes(key))) throw new Error('Arguments do not match this operation.');
  let method = operation === 'status' ? 'GET' : 'POST';
  let endpoint = { status: '/api/blog/state', refresh: '/api/blog/refresh', tick: '/api/blog/scheduler/tick' }[operation];
  let body;
  if (['login', 'deploy-plan', 'deploy'].includes(operation)) {
    const version = Number(options['--version']);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('Provide the exact positive --version from the current API state.');
    body = { expectedVersion: version };
    if (operation === 'login') {
      if (!accountIds.has(options['--account'])) throw new Error('Provide a known account id.');
      endpoint = `/api/blog/accounts/${encodeURIComponent(options['--account'])}/login`;
    } else {
      if (typeof options['--draft'] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(options['--draft'])) throw new Error('Provide an exact --draft identifier from the API.');
      endpoint = `/api/blog/drafts/${encodeURIComponent(options['--draft'])}/${operation}`;
      if (operation === 'deploy') {
        if (typeof options['--approval'] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(options['--approval'])) throw new Error('Provide an exact --approval identifier from the API.');
        body.approvalId = options['--approval'];
        if (options['--git-consent']) {
          if (!/^[a-f0-9]{64}$/.test(options['--git-consent'])) throw new Error('Provide the exact reviewed Git publication plan hash.');
          body.gitConsent = { approved: true, planHash: options['--git-consent'] };
        }
      }
    }
  } else if (operation !== 'status') body = {};
  return { command, operation, method, path: endpoint, ...(body ? { body } : {}) };
}

export async function runBlogWorkflow(argv, { env = process.env, fetchImpl = fetch } = {}) {
  const request = buildBlogRequest(argv);
  if (['help', '--help', '-h'].includes(request.command)) return help;
  if (request.command === 'cron') return `Draft-only cron command: node scripts/blog-workflow.mjs tick\nRun it from the FrameForge repository with BLOG_API_ORIGIN and a valid administrator session injected by the operator. The API processes only explicitly enabled due draft schedules, never publishes, never catches up publication slots and never changes existing Hermes/Aside routines or external LATEST pointers. No cron task has been registered or enabled.\n`;
  if (request.command === 'request') return request;
  let origin;
  try {
    origin = new URL(env.BLOG_API_ORIGIN || 'http://127.0.0.1:4310');
    if (origin.origin === 'null' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !['http:', 'https:'].includes(origin.protocol)) throw new Error();
    if (origin.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) throw new Error();
  } catch { throw new Error('BLOG_API_ORIGIN must be an HTTPS origin or loopback HTTP origin without credentials/path/query.'); }
  let cookie;
  if (env.BLOG_API_SESSION) {
    if (!/^[a-f0-9]{64}$/.test(env.BLOG_API_SESSION)) throw new Error('BLOG_API_SESSION must contain only the current session value.');
    cookie = `frameforge_session=${env.BLOG_API_SESSION}`;
  } else {
    if (!env.LOGIN_TOKEN) throw new Error('Configure BLOG_API_SESSION or LOGIN_TOKEN in the process environment before executing authenticated requests.');
    let login;
    try { login = await fetchImpl(new URL('/api/login', origin), { method: 'POST', headers: { 'content-type': 'application/json', origin: origin.origin }, body: JSON.stringify({ token: env.LOGIN_TOKEN }), redirect: 'error', signal: AbortSignal.timeout(15000) }); } catch { throw new Error('FrameForge authentication transport failed; no workflow request was sent.'); }
    if (!login.ok) throw new Error(`FrameForge authentication failed (${login.status}); no workflow request was sent.`);
    cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    if (!/^frameforge_session=[a-f0-9]{64}$/.test(cookie)) throw new Error('FrameForge did not return the expected authenticated session.');
  }
  let response;
  try {
    response = await fetchImpl(new URL(request.path, origin), { method: request.method, headers: { cookie, origin: origin.origin, ...(request.body ? { 'content-type': 'application/json' } : {}) }, ...(request.body ? { body: JSON.stringify(request.body) } : {}), redirect: 'error', signal: AbortSignal.timeout(240000) });
  } catch { throw new Error('Workflow transport failed or timed out. Do not retry an uncertain deployment; inspect its existing run and public evidence first.'); }
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Workflow response exceeds the bounded JSON contract.');
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('Workflow endpoint did not return JSON.'); }
  if (!response.ok) throw new Error(`Workflow rejected (${response.status}): ${typeof data.error === 'string' ? data.error.slice(0, 1000) : 'inspect current state and prerequisites'}`);
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await runBlogWorkflow(process.argv.slice(2));
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
