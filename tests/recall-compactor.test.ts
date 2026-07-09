import { describe, expect, test } from "bun:test";

import { compactRecall } from "../solarisael-house-proof/recall.ts";

function repeatedText(length: number) {
  return "x".repeat(length);
}

describe("recall compactor", () => {
  test("surfaces fused retrieval candidates with bounded candidate fields", () => {
    const longExcerpt = repeatedText(950);
    const candidates = Array.from({ length: 6 }, (_, index) => ({
      source_path: `memory/candidate-${index}.md`,
      title: `Candidate ${index}`,
      heading_path: `Heading > ${index}`,
      sources: ["semantic", "content", "canon", "date", "overflow"],
      score: 0.9 - index / 100,
      term_coverage: { matched: 2, total: 3 },
      matched_terms: ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"],
      missing_terms: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
      reasons: ["r1", "r2", "r3", "r4", "r5", "r6"],
      excerpt: longExcerpt,
      noisy_internal_field: "must not leak",
    }));

    const compact = compactRecall({
      ok: true,
      found: true,
      query: "candidate recall",
      source: "memory",
      retrievalCandidates: candidates,
    });

    expect(compact.retrievalCandidates).toHaveLength(5);
    expect(compact.retrievalCandidates[0]).toEqual({
      source_path: "memory/candidate-0.md",
      title: "Candidate 0",
      heading_path: "Heading > 0",
      sources: ["semantic", "content", "canon", "date"],
      score: 0.9,
      term_coverage: { matched: 2, total: 3 },
      matched_terms: ["one", "two", "three", "four", "five", "six", "seven", "eight"],
      missing_terms: ["a", "b", "c", "d", "e", "f", "g", "h"],
      reasons: ["r1", "r2", "r3", "r4", "r5"],
      excerpt: repeatedText(900),
    });
    expect(compact.retrievalCandidates.map((candidate) => candidate.source_path)).not.toContain(
      "memory/candidate-5.md",
    );
  });

  test("suppresses raw chunk arrays when fused retrieval candidates exist", () => {
    const compact = compactRecall({
      ok: true,
      found: true,
      query: "prefer fused candidates",
      source: "memory",
      retrievalCandidates: [
        {
          source_path: "memory/fused.md",
          title: "Fused result",
          excerpt: "The fused result is enough context.",
        },
      ],
      semanticChunks: [
        {
          source_path: "memory/raw-semantic.md",
          heading_path: "Raw semantic",
          sim: 0.99,
          body: "Raw semantic chunk should not be injected beside fused candidates.",
        },
      ],
      contentChunks: [
        {
          source_path: "memory/raw-content.md",
          heading_path: "Raw content",
          ws: 0.88,
          body: "Raw content chunk should not be injected beside fused candidates.",
        },
      ],
    });

    expect(compact.retrievalCandidates).toHaveLength(1);
    expect(compact.semanticChunks).toEqual([]);
    expect(compact.contentChunks).toEqual([]);
  });

  test("filters reverse-canon matches unless directly named or tied to a surfaced candidate path", () => {
    const compact = compactRecall({
      ok: true,
      found: true,
      query: "Explain Alias Gate without unrelated canon noise",
      source: "memory",
      retrievalCandidates: [
        {
          source_path: "house/memory/surfaced-candidate.md",
          title: "Surfaced candidate",
          excerpt: "The candidate source should allow directly connected canon context.",
        },
      ],
      canonMatches: [
        {
          termKey: "canonical-alias-entry",
          entry: {
            type: "project",
            summary: "Kept because the query directly names its alias.",
            aliases: ["Alias Gate"],
            files: [{ file: "memory/alias-entry.md", lines: [1, 4] }],
          },
        },
        {
          termKey: "candidate-linked-entry",
          entry: {
            type: "memory",
            summary: "Kept because one canon file is the surfaced candidate source.",
            aliases: ["Not Named"],
            files: [{ file: "memory/surfaced-candidate.md", lines: [8, 12] }],
          },
        },
        {
          termKey: "reverse-index-noise",
          entry: {
            type: "meta",
            summary: "Filtered because it is neither named nor linked to the surfaced source.",
            aliases: ["Noisy Alias"],
            files: [{ file: "memory/unrelated.md", lines: [20, 30] }],
          },
        },
      ],
    });

    expect(compact.canonMatches).toEqual([
      {
        termKey: "canonical-alias-entry",
        type: "project",
        summary: "Kept because the query directly names its alias.",
        files: [{ file: "memory/alias-entry.md", lines: [1, 4] }],
      },
      {
        termKey: "candidate-linked-entry",
        type: "memory",
        summary: "Kept because one canon file is the surfaced candidate source.",
        files: [{ file: "memory/surfaced-candidate.md", lines: [8, 12] }],
      },
    ]);
  });
});
