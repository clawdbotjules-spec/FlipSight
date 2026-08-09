import { describe, expect, it } from "vitest";
import { buildSearchQueries, misspellingVariants } from "./misspellings.js";

describe("misspellingVariants", () => {
  it("generates dropped-letter variants", () => {
    const variants = misspellingVariants("milwaukee");
    expect(variants).toContain("mlwaukee"); // dropped i
    expect(variants).toContain("milwauke"); // dropped final e
  });

  it("generates swapped-adjacent variants", () => {
    const variants = misspellingVariants("dewalt", { max: 50 });
    expect(variants).toContain("edwalt");
    expect(variants).toContain("dwealt");
  });

  it("generates missing-space variants for multi-word brands", () => {
    const variants = misspellingVariants("herman miller", { max: 100 });
    expect(variants).toContain("hermanmiller");
  });

  it("never returns the original word", () => {
    for (const brand of ["milwaukee", "herman miller", "snap-on"]) {
      expect(misspellingVariants(brand, { max: 100 })).not.toContain(brand);
    }
  });

  it("respects the max cap and skips too-short words", () => {
    expect(misspellingVariants("milwaukee", { max: 3 })).toHaveLength(3);
    expect(misspellingVariants("dji")).toHaveLength(0);
  });

  it("normalizes case and whitespace", () => {
    const variants = misspellingVariants("  MILWAUKEE  ");
    expect(variants.every((v) => v === v.toLowerCase())).toBe(true);
  });
});

describe("buildSearchQueries", () => {
  it("combines exact keywords with brand misspellings, deduplicated", () => {
    const queries = buildSearchQueries({
      keywords: ["milwaukee m18 fuel", "Milwaukee M18 Fuel"],
      brands: ["milwaukee"],
      maxMisspellingsPerBrand: 5,
    });
    expect(queries).toContain("milwaukee m18 fuel");
    expect(queries.filter((q) => q === "milwaukee m18 fuel")).toHaveLength(1);
    expect(queries.length).toBe(1 + 5);
    expect(queries).not.toContain("milwaukee"); // variants only, not the brand itself
  });
});
