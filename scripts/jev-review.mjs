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
const evidence = {};
for (const name of ['docker-live-production-smoke', 'docker-live-production-browser-smoke', 'live-container-smoke', 'docker-migration', 'docker-workflow-smoke', 'docker-verification']) {
  evidence[name] = JSON.parse(await readFile(`artifacts/${name}.json`, 'utf8'));
}
const task = 'Fix local Docker operation, build the missing container-to-Windows speech integration, independently review it and verify the real video editor before updating GitHub. Preserve existing channel/episode/media history and archived harness releases. The user explicitly authorized Docker deployment and Jev review.';
const proposal = {
  change: 'Recovered stuck WSLService using normal administrator consent, without resetting distributions or volumes. Added authenticated bounded WAV speech bridge, consistent read-only SQLite snapshot and no-overwrite importer. Staged and migrated existing data to a non-root read-only Docker service on the existing Tailscale URL. Added guarded repeatable launcher and preserved harness 1.2.0 under archive when promoting 1.3.0.',
  evidence,
  limits: ['Speech and agent CLI providers still require the Windows host bridge', 'Automated review decisions are test evidence, not owner creative acceptance or publication', 'YouTube OAuth publication and paid actor/video generation are not implemented', 'Jev receives this bounded implementation/evidence summary, not the whole source or private account database'],
};
const review = invoke(['review', task, JSON.stringify(proposal)]);
const receipt = { observedAt: new Date().toISOString(), host: 'codex', profile, runtimeMode: 'advisory', hookTrust: 'No automatic hook installed or trusted', upstreamCommit: process.env.JEV_RUNTIME_COMMIT || null, liveReviewExecuted: true, mockIsLiveEvidence: false, hostAuthorizationGranted: false, task, proposal, review };
await writeFile('artifacts/jev-docker-review.json', `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ profile, verdict: review.verdict, backend: review.backend, receipt: review.receipt, error: review.review?.error || null }));
if (review.verdict === 'unavailable') process.exitCode = 2;
