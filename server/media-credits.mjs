/** Source-backed credits in scene/slot order, followed by episode music. */
export function requiredMediaCredits(sceneList, music) {
  const credits = new Set();
  for (const scene of sceneList || []) {
    for (const source of [scene.source, scene.audioSource, ...(scene.slots || []).map((slot) => slot.source)]) {
      if (!source || typeof source !== 'object') continue;
      const credit = [source.attribution, source.licenseId, source.sourceUrl]
        .filter((value) => typeof value === 'string' && value.trim())
        .map((value) => value.trim()).join(' | ');
      if (credit) credits.add(credit);
    }
  }
  if (music?.source && typeof music.source === 'object') {
    const credit = [music.source.attribution, music.source.licenseId, music.source.sourceUrl]
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim()).join(' | ');
    if (credit) credits.add(credit);
  }
  return [...credits].join('\n');
}
