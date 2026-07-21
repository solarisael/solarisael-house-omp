import { describe, expect, test } from "bun:test";
import { compactRecall } from "../solarisael-house-proof/recall.ts";
import {
  automaticRecallViewport,
  createRecallViewportSession,
  EVIDENCE_BUNDLE_LABELS,
} from "../solarisael-house-proof/recall-viewport.ts";

const candidate = (overrides: Record<string, unknown> = {}) => ({
  source_path: "memory/example.md",
  title: "Example memory",
  matched_terms: ["alpha", "beta"],
  sources: ["memory"],
  ...overrides,
});

const recall = (retrievalCandidates: unknown[], extra: Record<string, unknown> = {}) => ({
  query: "alpha beta",
  retrievalCandidates,
  ...extra,
});

describe("automatic recall viewport", () => {
  test("suppresses zero-term and glue-only candidates", () => {
    const result = automaticRecallViewport(recall([
      candidate({ matched_terms: [] }),
      candidate({ source_path: "memory/glue.md", matched_terms: ["please", "the"] }),
    ]));
    expect(result.keptCandidates).toHaveLength(0);
    expect(result.suppressions.map((s) => s.reason)).toEqual(["zero-terms", "glue-only"]);
  });

  test("does not treat generic operational terms as exact title evidence", () => {
    const result = automaticRecallViewport({
      query: "did the verification work?",
      retrievalCandidates: [
        candidate({
          source_path: "memory/release-check.md",
          title: "Did the release verification work end-to-end?",
          matched_terms: ["work"],
        }),
        candidate({
          source_path: "memory/service-check.md",
          title: "Background service work completed",
          matched_terms: ["works"],
        }),
      ],
    });

    expect(result.keptCandidates).toHaveLength(0);
    expect(result.suppressions.map((suppression) => suppression.reason)).toEqual(["glue-only", "glue-only"]);
  });

  test("keeps exact entity, project, and date signals", () => {
    const result = automaticRecallViewport(recall([
      candidate({ source_path: "memory/entity.md", matched_terms: ["orchid"], sources: ["entity"] }),
      candidate({ source_path: "memory/project.md", matched_terms: ["northstar"], sources: ["project_lesson"] }),
      candidate({ source_path: "memory/date.md", matched_terms: ["2030-01-02"], sources: ["date"] }),
    ]));
    expect(result.keptCandidates).toHaveLength(3);
    expect(result.diagnostics.aperture.authorityComplexity).toBe(true);
    expect(result.diagnostics.aperture.sourceComplexity).toBeGreaterThan(3);
  });

  test("keeps candidates with two independent meaningful terms", () => {
    const result = automaticRecallViewport(recall([candidate({ matched_terms: ["alpha", "beta"] })]));
    expect(result.keptCandidates).toHaveLength(1);
  });

  test("saturates repeated identities but permits another relevant result", () => {
    const session = createRecallViewportSession();
    const repeated = candidate({ id: "same" });
    const other = candidate({ id: "other", source_path: "memory/other.md" });
    expect(automaticRecallViewport(recall([repeated]), { session, saturationLimit: 2 }).keptCandidates).toHaveLength(1);
    expect(automaticRecallViewport(recall([repeated]), { session, saturationLimit: 2 }).keptCandidates).toHaveLength(1);
    const third = automaticRecallViewport(recall([repeated, other]), { session, saturationLimit: 2 });
    expect(third.keptCandidates).toEqual([other]);
    expect(third.suppressions[0].reason).toBe("saturated");
  });

  test("returns a successful empty result with a zero-width aperture", () => {
    const result = automaticRecallViewport(recall([]));
    expect(result.candidates).toEqual([]);
    expect(result.keptCandidates).toEqual([]);
    expect(result.evidenceBundles).toEqual([]);
    expect(result.suppressions).toEqual([]);
    expect(result.diagnostics).toMatchObject({
      kept: 0,
      suppressed: 0,
      reasons: {},
      pool: { available: 0, inspected: 0, uninspected: 0 },
      aperture: { selectedBundles: 0, bundleLimit: 0 },
      selection: [],
    });
  });

  test("filters the bounded automatic pool before selecting a candidate beyond old rank five", () => {
    const rawCandidates = [
      ...Array.from({ length: 5 }, (_, index) => candidate({
        source_path: `memory/noise-${index}.md`,
        matched_terms: ["alpha"],
      })),
      candidate({
        source_path: "memory/rank-six.md",
        title: "Rank six relevant memory",
        matched_terms: ["alpha", "beta"],
      }),
    ];
    const explicit = compactRecall(recall(rawCandidates));
    const automatic = compactRecall(recall(rawCandidates), { retrievalCandidateLimit: 24 });

    expect(explicit.retrievalCandidates).toHaveLength(5);
    const result = automaticRecallViewport(automatic);
    expect(result.keptCandidates.map((item) => item.source_path)).toEqual(["memory/rank-six.md"]);
    expect(result.diagnostics.pool).toMatchObject({ available: 6, inspected: 6 });
    expect(result.diagnostics.selection[0]).toMatchObject({ rank: 5 });
  });

  test("expands ambiguous distinct claims and contracts exact convergent evidence", () => {
    const expanded = automaticRecallViewport({
      query: "alpha",
      retrievalCandidates: Array.from({ length: 6 }, (_, index) => candidate({
        id: `claim-${index}`,
        source_path: `memory/claim-${index}.md`,
        title: `Distinct claim ${index} about outcome ${index}`,
        matched_terms: ["alpha", `signal-${index}`],
      })),
    });
    expect(expanded.diagnostics.aperture.ambiguous).toBe(true);
    expect(expanded.keptCandidates.length).toBeGreaterThan(2);
    expect(expanded.diagnostics.aperture.bundleLimit).toBe(expanded.keptCandidates.length);

    const contracted = automaticRecallViewport({
      query: "Orchid Protocol",
      retrievalCandidates: Array.from({ length: 4 }, (_, index) => candidate({
        id: `orchid-${index}`,
        source_path: `memory/orchid-${index}.md`,
        title: "Orchid Protocol",
        matched_terms: ["Orchid Protocol"],
        sources: ["entity", "memory"],
      })),
    });
    expect(contracted.diagnostics.aperture).toMatchObject({
      convergent: true,
      exactConvergent: true,
      bundleLimit: 1,
      selectedBundles: 1,
    });
    expect(contracted.keptCandidates).toHaveLength(1);
    expect(contracted.diagnostics.selection[0].reason).toContain("contracted aperture");
  });

  test("opens the aperture for contradictory evidence about the same claim", () => {
    const result = automaticRecallViewport(recall([
      candidate({
        id: "safe",
        source_path: "memory/safe.md",
        title: "Deployment is safe",
        excerpt: "The deployment is safe after verification.",
      }),
      candidate({
        id: "not-safe",
        source_path: "memory/not-safe.md",
        title: "Deployment is not safe",
        excerpt: "The deployment is not safe after verification.",
      }),
    ]));

    expect(result.diagnostics.aperture).toMatchObject({
      contradiction: true,
      convergent: true,
      bundleLimit: 2,
      selectedBundles: 2,
    });
    expect(result.keptCandidates).toHaveLength(2);
  });

  test("enforces the hard global excerpt budget and clips at sentence boundaries", () => {
    const excerpt = "First complete sentence. Second sentence carries substantially more detail than the viewport can afford. Third sentence is also long.";
    const result = automaticRecallViewport(recall([
      candidate({ id: "budget-a", title: "Budget claim A", excerpt }),
      candidate({ id: "budget-b", source_path: "memory/budget-b.md", title: "Budget claim B", excerpt }),
    ]), { maxGlobalExcerptChars: 120 });
    const excerptChars = result.evidenceBundles.reduce((sum, bundle) => sum + bundle["Excerpt"].length, 0);

    expect(excerptChars).toBeLessThanOrEqual(120);
    expect(result.evidenceBundles.every((bundle) => bundle["Excerpt"].endsWith("."))).toBe(true);
    expect(result.diagnostics.budget).toEqual({
      hardLimit: 120,
      adaptedLimit: 120,
      used: excerptChars,
      remaining: 120 - excerptChars,
    });
  });

  test("renders frozen bundles with stable labels, provenance, authority, and human dates", () => {
    const result = automaticRecallViewport(recall([
      candidate({
        source_path: "memory/2026-07-21_orchid.md",
        title: "Orchid decision",
        sources: ["canon", "memory"],
        excerpt: "The canonical decision stands.",
      }),
    ]));
    const bundle = result.evidenceBundles[0];

    expect(Object.keys(bundle)).toEqual(EVIDENCE_BUNDLE_LABELS);
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(bundle).toMatchObject({
      "Evidence kind": "Canonical evidence",
      "Title": "Orchid decision",
      "Authority state": "Authoritative canon",
      "Source / provenance": "memory/2026-07-21_orchid.md · canon + memory",
      "Human date": "July 21, 2026",
      "Excerpt": "The canonical decision stands.",
    });
    expect(bundle["Selection reason"]).toContain("highest-ranked eligible evidence");
  });
});
