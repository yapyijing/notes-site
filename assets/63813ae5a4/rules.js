// Lock and Hide rules, shared by the build script and the admin console.
//
//   Lock: users see the name, but only keys granted that lock can open it.
//   Hide: left out of the site entirely, except for keys granted that hide.
//
//   No download: users can preview it but not download it, on its own or inside a folder .zip.
//                Independent of Lock and Hide (and of grants).
//
// Rules live in .notes/locks.json as { v: 2, locked: [paths], hidden: [paths], nodownload: [paths] }.
// A key's grants (in .notes/keys.json) name the locked or hidden paths it may open.

/** True when `path` is `root` itself or lies inside it. */
export const covers = (root, path) => path === root || path.startsWith(root + '/');

const cleanPath = (p) => String(p).replace(/^\/+|\/+$/g, '');

/** Read either the v1 ({ locked }) or v2 ({ locked, hidden, nodownload }) format. */
export function normaliseRules(doc) {
  const list = (a) => [...new Set((Array.isArray(a) ? a : []).map(cleanPath).filter(Boolean))].sort();
  const hidden = list(doc?.hidden);
  // Hide wins over Lock on the same path.
  const locked = list(doc?.locked).filter((p) => !hidden.includes(p));
  return { locked, hidden, nodownload: list(doc?.nodownload) };
}

/** True when downloading is turned off for `path` (by itself or a folder around it). */
export const isNoDownload = (rules, path) => rules.nodownload.some((r) => covers(r, path));

/** Every rule that applies to `path`, outermost first. */
export function rulesFor(rules, path) {
  return [
    ...rules.locked.filter((r) => covers(r, path)).map((r) => ({ kind: 'lock', path: r })),
    ...rules.hidden.filter((r) => covers(r, path)).map((r) => ({ kind: 'hide', path: r })),
  ].sort((a, b) => a.path.length - b.path.length);
}

export const isHiddenPath = (rules, path) => rules.hidden.some((r) => covers(r, path));

/**
 * Whether a key with these grants may open `path`.
 * Each rule over the path needs a grant at or inside that rule which still covers the path,
 * so a hidden folder inside a granted locked folder stays hidden until it is granted too.
 */
export function canOpen(rules, grants = [], path) {
  return rulesFor(rules, path).every((r) => grants.some((g) => covers(r.path, g) && covers(g, path)));
}
