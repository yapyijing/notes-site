// Stable IDs for folders (F-XXXXXX) and documents (D-XXXXXX), shared by the build, the site and the admin.
//
// X is A–Z or 0–9 without I and O. A new item's ID comes from a hash of its path, so the build, the
// admin console and the Mac sync script all give it the same one. .notes/ids.json remembers every ID,
// so an item keeps its ID when it is renamed or moved.

const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const te = new TextEncoder();

export const ID_PATTERN = /^[FD]-[0-9A-HJ-NP-Z]{6}$/;

/** Shape of .notes/ids.json: { v: 1, dirs: { path: id }, files: { path: id } }. */
export function normaliseIds(doc) {
  const pick = (o, kind) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {})
    .filter(([p, id]) => p && typeof id === 'string' && ID_PATTERN.test(id) && id[0] === kind));
  return { v: 1, dirs: pick(doc?.dirs, 'F'), files: pick(doc?.files, 'D') };
}

/** Every ID in a registry, for collision checks. */
export const takenIds = (reg) => new Set([...Object.values(reg.dirs), ...Object.values(reg.files)]);

/** The ID a new item gets: 'F' for a folder, 'D' for a document. Skips any ID in `taken`. */
export async function makeId(kind, path, taken = new Set()) {
  for (let n = 0; ; n++) {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', te.encode(`vault-id:${kind}:${path}:${n}`)));
    let x = 0n;
    for (const b of digest.subarray(0, 8)) x = (x << 8n) | BigInt(b);
    let body = '';
    for (let i = 0; i < 6; i++) {
      body += ALPHABET[Number(x % 34n)];
      x /= 34n;
    }
    const id = `${kind}-${body}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Fill in IDs for paths the registry does not know yet, and drop paths that no longer exist.
 * Returns true when the registry changed. Paths are handled in sorted order, so results are repeatable.
 */
export async function completeIds(reg, dirPaths, filePaths) {
  let changed = false;
  for (const [kind, key, paths] of [['F', 'dirs', dirPaths], ['D', 'files', filePaths]]) {
    const want = new Set(paths);
    for (const p of Object.keys(reg[key])) {
      if (!want.has(p)) {
        delete reg[key][p];
        changed = true;
      }
    }
    const taken = takenIds(reg);
    for (const p of [...want].sort()) {
      if (reg[key][p]) continue;
      reg[key][p] = await makeId(kind, p, taken);
      taken.add(reg[key][p]);
      changed = true;
    }
  }
  return changed;
}

/** Every folder above these file paths. */
export function foldersOf(filePaths) {
  const out = new Set();
  for (const p of filePaths) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) out.add(segs.slice(0, i).join('/'));
  }
  return [...out];
}

/** Read what someone typed as an ID: "d 7f3k9q", "D7F3K9Q" and "D-7F3K9O" all work. */
export function parseId(input) {
  const s = String(input || '').toUpperCase().replace(/[\s-]/g, '');
  const m = s.match(/^([FD])([0-9A-Z]{6})$/);
  if (!m) return null;
  const id = `${m[1]}-${m[2].replace(/O/g, '0').replace(/I/g, '1')}`;
  return ID_PATTERN.test(id) ? id : null;
}

/** Sort-stable JSON for .notes/ids.json, so diffs stay small. */
export function idsJson(reg) {
  const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  return JSON.stringify({ v: 1, dirs: sorted(reg.dirs), files: sorted(reg.files) }, null, 2) + '\n';
}
