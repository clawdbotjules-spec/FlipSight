/**
 * Programmatic misspelling generation for high-value brand keywords.
 * Mislisted items (a "Milwakee" drill) get little bidding competition, so
 * sweeping misspelling variants is one of the best arbitrage edges on eBay.
 *
 * Variant strategies (per spec): dropped letters, swapped adjacent letters,
 * and missing spaces for multi-word brands.
 */

export interface MisspellingOptions {
  /** Maximum variants returned (default 12). */
  max?: number;
}

export function misspellingVariants(word: string, options: MisspellingOptions = {}): string[] {
  const max = options.max ?? 12;
  const normalized = word.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized.length < 4) return [];

  const variants = new Set<string>();

  // Missing spaces — "herman miller" → "hermanmiller" (whole word and each gap).
  if (normalized.includes(" ")) {
    variants.add(normalized.replaceAll(" ", ""));
    let searchFrom = 0;
    for (;;) {
      const gap = normalized.indexOf(" ", searchFrom);
      if (gap === -1) break;
      variants.add(normalized.slice(0, gap) + normalized.slice(gap + 1));
      searchFrom = gap + 1;
    }
  }

  // Dropped letters — skip the first character (rarely mistyped) and spaces.
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i] === " ") continue;
    const dropped = normalized.slice(0, i) + normalized.slice(i + 1);
    variants.add(dropped.replace(/\s{2,}/g, " ").trim());
  }

  // Swapped adjacent letters — "milwaukee" → "imlwaukee", "mliwaukee", …
  for (let i = 0; i < normalized.length - 1; i++) {
    if (normalized[i] === " " || normalized[i + 1] === " ") continue;
    const chars = normalized.split("");
    const tmp = chars[i]!;
    chars[i] = chars[i + 1]!;
    chars[i + 1] = tmp;
    variants.add(chars.join(""));
  }

  variants.delete(normalized);
  return [...variants].slice(0, max);
}

/**
 * Expand a keyword set into the concrete query strings a sweep executes:
 * the exact keywords plus misspelling variants of each brand term.
 */
export function buildSearchQueries(input: {
  keywords: string[];
  brands: string[];
  maxMisspellingsPerBrand?: number;
}): string[] {
  const queries = new Set<string>();
  for (const keyword of input.keywords) {
    const trimmed = keyword.trim();
    if (trimmed !== "") queries.add(trimmed.toLowerCase());
  }
  for (const brand of input.brands) {
    for (const variant of misspellingVariants(brand, { max: input.maxMisspellingsPerBrand ?? 8 })) {
      queries.add(variant);
    }
  }
  return [...queries];
}
