import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// The user configures a private profile outside this repository. No credentials
// or catalog are copied here, and advisory output never authorizes host actions.
const harness = process.env.JEV_HARNESS_PATH;
const profileHome = process.env.JEV_PROFILE_HOME;
const profile = process.env.JEV_PROFILE || 'frameforge-codex';
if (!harness || !profileHome) throw new Error('Set JEV_HARNESS_PATH and JEV_PROFILE_HOME to the isolated configured runtime');
const env = { ...process.env, USERPROFILE: path.resolve(profileHome) };
const invoke = args => {
  const result = spawnSync(process.execPath, [harness, '--profile', profile, ...args], { env, encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Jev ${args[0]} failed (exit ${result.status ?? 'unavailable'}); inspect the private runtime locally`);
  return JSON.parse(result.stdout);
};
const configured = invoke(['status', '--operation', 'review']);
if (!configured.active || !configured.policies?.review?.usable) throw new Error('Selected Jev review profile is unavailable');
const production = JSON.parse(await readFile('artifacts/production-smoke.json', 'utf8'));
const task = 'Implement a working video editor with local narration, preservation of authored scenes in a node workflow, and durable review of the exact exported video. Keep old harness releases archived.';
const proposal = {
  change: 'Windows SAPI narration queue with optimistic version protection; saved-scene workflow; exact version/job/SHA256-bound approval or revision request; harness 1.2.0 with prior versions preserved.',
  evidence: { localTests: '55 passing API, workflow, narration, review and harness tests', production },
  limits: ['Native narration requires Windows installed voices', 'Review smoke decisions are automated tests, not owner acceptance', 'YouTube publication is not implemented', 'Local Docker host is blocked by WSL service state; Linux CI is separately verified'],
};
const review = invoke(['review', task, JSON.stringify(proposal)]);
const receipt = { observedAt: new Date().toISOString(), host: 'codex', profile, runtimeMode: 'advisory', hookTrust: 'No automatic hook installed or trusted', upstreamCommit: process.env.JEV_RUNTIME_COMMIT || null, liveReviewExecuted: true, mockIsLiveEvidence: false, hostAuthorizationGranted: false, review };
await writeFile('artifacts/jev-live-review.json', `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ profile, verdict: review.verdict, backend: review.backend, receipt: review.receipt, error: review.review?.error || null }));
if (review.verdict === 'unavailable') process.exitCode = 2;
