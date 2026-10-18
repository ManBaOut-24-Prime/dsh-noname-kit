// Pure metadata comparison. This module has no filesystem or transfer route.
export function compareManifests(host, guest) {
  const split = (a, b) => ({ missing: a.filter(n => !b.includes(n)), extra: b.filter(n => !a.includes(n)) });
  const exts = split(host.exts, guest.installed || guest.exts);
  Object.assign(exts, { disabled: [], changed: [], matching: [], unverified: [] });
  for (const name of host.exts) {
    if (exts.missing.includes(name)) continue;
    const a = host.contents?.[name], b = guest.contents?.[name];
    if (host.inventoryVersion !== 1 || guest.inventoryVersion !== 1 || !a?.digest || !b?.digest) exts.unverified.push(name);
    else if (a.digest !== b.digest) exts.changed.push(name);
    else if (!guest.exts.includes(name)) exts.disabled.push(name);
    else exts.matching.push(name);
  }
  exts.needsFiles = [...exts.missing, ...exts.changed].filter(name => host.contents?.[name]?.digest);
  return {
    exts, packs: split(host.packs || [], guest.packs || []), cards: split(host.cards || [], guest.cards || []),
    guestKernel: guest.kernel || null, hostKernel: host.kernel || null,
    guestBatchProtocol: guest.batchProtocol || null, hostBatchProtocol: host.batchProtocol || null,
    guestIdentity: guest.identity || null, hostIdentity: host.identity || null,
    inventoryVerified: host.inventoryVersion === 1 && guest.inventoryVersion === 1
      && !host.inventoryError && !guest.inventoryError && !exts.unverified.length,
    inventoryErrors: { host: !!host.inventoryError, guest: !!guest.inventoryError },
  };
}
