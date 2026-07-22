// Name/symbol content screen for tokens landing in the drop wallet. This is
// separate from screenMint()'s extension/authority checks -- a token can be
// technically clean (no freeze authority, no hostile extension) and still
// be something this project should never forward to real holders because
// of what it's named. Confirmed need: on 2026-07-19 the sweep pipeline
// auto-distributed a swastika-referencing token to 100 wallets and an
// ableist-slur-named token to 40 wallets, purely because nothing screened
// for it.
//
// Two match tiers, because a flat substring scan has a real false-positive
// problem: "coon" and "spic" are common slur roots that also sit inside
// ordinary words ("raccoon", "despicable", "hospice"). SUBSTRING_PATTERNS
// are distinctive enough to match anywhere (nobody spells "swasticoin" by
// accident); WORD_PATTERNS only fire on an exact tokenized word, so
// "Rickie The Raccoon" doesn't get caught by "coon". Both tiers are
// case-insensitive with light leetspeak normalization to catch cheap
// evasion (0/1/3/$ substitutions).
//
// This is deliberately blunt, not clever, and a first pass, not a claim of
// completeness. A hit lands in the same quarantine lane as a failed
// extension screen -- reviewable and reversible, not destructive. Reasons
// returned name the category only, never the matched text, so a flagged
// mint doesn't get the slur repeated back out through logs, notify(), or
// the Discord workflow drafts that read pipeline state.

const SUBSTRING_PATTERNS: Record<string, string[]> = {
  'hate-symbol-reference': ['swastika', 'swastic', 'nazi', 'hitler', '1488', 'sieg'],
  'racial-slur-pattern': ['nigger', 'nigga', 'chink', 'gook', 'wetback'],
  'antisemitic-slur-pattern': ['kike'],
  'ableist-slur-pattern': ['retard', 'spastic', 'spaztic', 'spazm', 'cripple'],
  'homophobic-transphobic-slur-pattern': ['faggot', 'tranny'],
  'misogynistic-slur-pattern': ['whore'],
};

// Short roots that collide with common words -- only flagged on an exact
// tokenized word match, never as a substring.
const WORD_PATTERNS: Record<string, string[]> = {
  'racial-slur-pattern': ['coon', 'spic'],
  'misogynistic-slur-pattern': ['cunt'],
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[0@]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/[3]/g, 'e')
    .replace(/[4]/g, 'a')
    .replace(/[$5]/g, 's');
}

export function checkTokenContent(name: string | null | undefined, symbol: string | null | undefined): { ok: boolean; reasons: string[] } {
  const raw = `${name ?? ''} ${symbol ?? ''}`;
  const normalized = normalize(raw);
  const collapsed = normalized.replace(/[^a-z0-9]/g, '');
  const words = new Set(normalized.split(/[^a-z0-9]+/).filter(Boolean));

  const reasons = new Set<string>();

  for (const [category, patterns] of Object.entries(SUBSTRING_PATTERNS)) {
    for (const p of patterns) {
      if (collapsed.includes(p)) {
        reasons.add(category);
        break;
      }
    }
  }
  for (const [category, patterns] of Object.entries(WORD_PATTERNS)) {
    for (const p of patterns) {
      if (words.has(p)) {
        reasons.add(category);
        break;
      }
    }
  }

  return { ok: reasons.size === 0, reasons: [...reasons] };
}
