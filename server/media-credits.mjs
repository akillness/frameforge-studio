/** Source-backed credits in scene/slot order, shared by rendering and publication. */
export function requiredMediaCredits(sceneList) {
  const credits = new Set();
  for (const scene of sceneList || []) {
    for (const item of [scene, ...(scene.slots || [])]) {
      const source = item.source;
      if (!source || typeof source !== 'object') continue;
      const credit = [source.attribution, source.licenseId, source.sourceUrl]
        .filter((value) => typeof value === 'string' && value.trim())
        .map((value) => value.trim()).join(' | ');
      if (credit) credits.add(credit);
    }
  }
  return [...credits].join('\n');
}
