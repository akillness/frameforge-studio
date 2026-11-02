export const MIN_REFERENCE_AUDIENCE = 10_000;
export const BLOG_REFERENCE_POLICY_VERSION = 'blog-reference-policy-2';

const NAVER_HOSTS = new Set(['in.naver.com', 'blog.naver.com', 'm.blog.naver.com']);
const METRIC_KINDS = new Set(['fans', 'neighbors']);
const SHA256 = /^[a-f0-9]{64}$/;
const hasHash = value => typeof value === 'string' && SHA256.test(value);
const hasObservedTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function isPublicNaverUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && NAVER_HOSTS.has(url.hostname) && !url.username && !url.password && !url.port && !url.hash;
  } catch { return false; }
}

function matchingSource(sources, { url, sha256, observedAt, kind }) {
  return sources.some(source => source?.kind === kind && source.url === url && source.sha256 === sha256 && source.observedAt === observedAt);
}

/** Shared browser/server gate for source-backed Naver reference evidence. */
export function hasVerifiedReferenceEvidence(reference) {
  const metric = reference?.metricEvidence;
  const sources = reference?.sourceRegistry;
  const samples = reference?.references;
  if (reference?.status !== 'analyzed' || reference.policyVersion !== BLOG_REFERENCE_POLICY_VERSION ||
      typeof reference.category !== 'string' || !reference.category.trim() ||
      !hasHash(reference.fingerprint) || !hasHash(reference.contextFingerprint) ||
      !METRIC_KINDS.has(metric?.kind) || !Number.isSafeInteger(metric?.count) || metric.count < MIN_REFERENCE_AUDIENCE ||
      !['exact-displayed', 'displayed-lower-bound'].includes(metric?.precision) || !isPublicNaverUrl(metric.url) ||
      !hasObservedTime(metric.observedAt) || typeof metric.excerpt !== 'string' || !metric.excerpt.trim() || !hasHash(metric.sha256) ||
      !Array.isArray(sources) || !matchingSource(sources, { url: metric.url, sha256: metric.sha256, observedAt: metric.observedAt, kind: 'profile' }) ||
      !Array.isArray(samples) || samples.length === 0 || typeof reference.rightsStatement !== 'string' ||
      !/structural analysis only/i.test(reference.rightsStatement) || !/original prose/i.test(reference.rightsStatement) || !/rights-cleared assets/i.test(reference.rightsStatement)) return false;

  const observationIds = new Set();
  const sampleUrls = new Set();
  for (const sample of samples) {
    if (!sample || typeof sample.authorId !== 'string' || !sample.authorId || !isPublicNaverUrl(sample.sourceUrl) ||
        !hasHash(sample.sha256) || !hasObservedTime(sample.observedAt) ||
        !matchingSource(sources, { url: sample.sourceUrl, sha256: sample.sha256, observedAt: sample.observedAt, kind: 'post' }) ||
        sample.categoryEvidence?.status !== 'supported-by-public-content' || sample.categoryEvidence.category !== reference.category ||
        !['same-platform-account', 'observed-profile-outbound-blog-link'].includes(sample.ownership?.method) ||
        sample.ownership.authorId !== sample.authorId || sample.ownership.profileUrl !== metric.url || sample.ownership.profileSha256 !== metric.sha256 ||
        (metric.kind === 'neighbors' && metric.audienceOwnerId !== sample.authorId)) return false;

    const measurements = sample.measurements;
    if (!Number.isSafeInteger(measurements?.headings?.count) || !Number.isSafeInteger(measurements?.paragraphs?.count) || measurements.paragraphs.count < 2 ||
        !Number.isFinite(measurements.paragraphs.meanCharacters) || measurements.paragraphs.meanCharacters <= 0 ||
        !Number.isSafeInteger(measurements?.images?.count) || !Array.isArray(measurements.images.positions) ||
        !measurements.formatting || !Array.isArray(measurements.formatting.inlineLineHeight)) return false;

    const observations = sample.observations;
    if (!Array.isArray(observations) || !['layout', 'images', 'formatting'].every(kind => observations.some(item => item?.kind === kind))) return false;
    for (const observation of observations) {
      if (!observation || typeof observation.id !== 'string' || !observation.id || !observation.summary ||
          !['layout', 'images', 'formatting'].includes(observation.kind) || observation.sourceUrl !== sample.sourceUrl ||
          observation.sha256 !== sample.sha256 || observation.observedAt !== sample.observedAt) return false;
      observationIds.add(observation.id);
    }
    sampleUrls.add(sample.sourceUrl);
  }

  return ['layout', 'images', 'formatting', 'adaptation'].every(section => {
    const plans = reference.analysis?.[section];
    return Array.isArray(plans) && plans.length === samples.length && plans.every(plan =>
      typeof plan?.guidance === 'string' && plan.guidance.trim() && Array.isArray(plan.basedOn) && plan.basedOn.length > 0 &&
      plan.basedOn.every(id => observationIds.has(id)) && Array.isArray(plan.sourceUrls) && plan.sourceUrls.some(url => sampleUrls.has(url)));
  });
}
