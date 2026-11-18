// Shared settings.
export const CONFIG = {
  owner: 'yapyijing',
  vaultRepo: 'notes-vault',
  siteName: "Jing's Vault",
  siteRepo: 'yapyijing.github.io',
  branch: 'main',
  publishWorkflow: 'publish.yml',
  siteUrl: 'https://yapyijing.github.io/',
  // The vault API (Cloudflare Worker). It checks every request against Lock, Hide and the key's grants.
  apiBase: 'https://vault-api.vault-api.workers.dev',
  ownerName: 'Jing',
  // Prefixes people may type out of habit; they map to the root of the notes.
  pathAliases: ['Users/yapyijing/Documents/2026-09/', 'Documents/2026-09/', '2026-09/'],
};
