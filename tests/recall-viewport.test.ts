import { describe, expect, test } from "bun:test";
import { compactRecall, filterCanonMatchesForCandidates } from "../solarisael-house-proof/recall.ts";
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

  test("does not declare exact convergence for a singleton exact candidate", () => {
    const result = automaticRecallViewport({
      query: "Orchid Protocol",
      retrievalCandidates: [
        candidate({
          id: "exact-singleton",
          source_path: "memory/orchid-singleton.md",
          title: "Orchid Protocol",
          matched_terms: ["Orchid Protocol"],
          sources: ["entity", "memory"],
        }),
      ],
    });

    expect(result.diagnostics.aperture).toMatchObject({
      exactConvergent: false,
      bundleLimit: 1,
      selectedBundles: 1,
    });
    expect(result.diagnostics.selection[0].reason).not.toContain("contracted aperture");
  });

  test("does not contract a mixed exact and non-exact convergent set", () => {
    const result = automaticRecallViewport({
      query: "Orchid Protocol",
      retrievalCandidates: [
        candidate({
          id: "mixed-exact",
          source_path: "memory/mixed-exact.md",
          title: "Shared aperture outcome",
          reasons: ["named entity"],
        }),
        candidate({
          id: "mixed-non-exact",
          source_path: "memory/mixed-non-exact.md",
          title: "Shared aperture outcome",
        }),
      ],
    });

    expect(result.diagnostics.aperture).toMatchObject({
      convergent: true,
      exactConvergent: false,
      bundleLimit: 2,
      selectedBundles: 2,
    });
    expect(result.keptCandidates).toHaveLength(2);
  });

  test("does not contract contradictory exact candidates", () => {
    const result = automaticRecallViewport({
      query: "Orchid Protocol",
      retrievalCandidates: [
        candidate({
          id: "exact-safe",
          source_path: "memory/exact-safe.md",
          title: "Orchid Protocol is safe",
          excerpt: "Orchid Protocol is safe after verification.",
          reasons: ["named entity"],
        }),
        candidate({
          id: "exact-not-safe",
          source_path: "memory/exact-not-safe.md",
          title: "Orchid Protocol is not safe",
          excerpt: "Orchid Protocol is not safe after verification.",
          reasons: ["named entity"],
        }),
      ],
    });

    expect(result.diagnostics.aperture).toMatchObject({
      contradiction: true,
      exactConvergent: false,
      bundleLimit: 2,
      selectedBundles: 2,
    });
    expect(result.keptCandidates).toHaveLength(2);
    expect(result.diagnostics.selection.every(({ reason }) => !reason.includes("contracted aperture"))).toBe(true);
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
        excerpt: "x".repeat(1000),
      })),
      candidate({
        source_path: "memory/rank-six.md",
        title: "Rank six relevant memory",
        matched_terms: ["alpha", "beta"],
        excerpt: "x".repeat(1000),
      }),
    ];
    const explicit = compactRecall(recall(rawCandidates));
    const automatic = compactRecall(recall(rawCandidates), { retrievalCandidateLimit: 24 });

    expect(explicit.retrievalCandidates).toHaveLength(5);
    expect(explicit.retrievalCandidates.every((item) => item.excerpt.length === 900)).toBe(true);
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
      "Lifecycle state": "Active",
      "Source / provenance": "memory/2026-07-21_orchid.md · canon + memory",
      "Human date": "July 21, 2026",
      "Excerpt": "The canonical decision stands.",
    });
    expect(bundle["Selection reason"]).toContain("highest-ranked eligible evidence");
  });

  test("preserves authority, lifecycle, and date metadata through automatic compaction", () => {
    const compact = compactRecall(recall([
      candidate({
        id: "historical-orchid",
        source_path: "memory/historical-orchid.md",
        authority_state: "historical",
        historical: true,
        archived: true,
        archived_at: "2026-07-20T10:00:00.000Z",
        superseded: true,
        superseded_by: 42,
        human_date: "2026-07-18",
      }),
    ]), { retrievalCandidateLimit: 24 });

    expect(compact.retrievalCandidates[0]).toMatchObject({
      id: "historical-orchid",
      authority_state: "historical",
      historical: true,
      archived: true,
      archived_at: "2026-07-20T10:00:00.000Z",
      superseded: true,
      superseded_by: 42,
      human_date: "2026-07-18",
    });
    expect(automaticRecallViewport(compact).evidenceBundles[0]).toMatchObject({
      "Authority state": "historical",
      "Lifecycle state": "Superseded by 42; Archived 2026-07-20T10:00:00.000Z",
      "Human date": "July 18, 2026",
    });
  });

  test("keeps canon linked to selected paths or the direct query only after aperture selection", () => {
    const compact = compactRecall({
      query: "What does direct-canon say about Orchid Protocol?",
      retrievalCandidates: [
        candidate({ id: "selected", source_path: "memory/selected.md" }),
        candidate({ id: "rejected", source_path: "memory/rejected.md" }),
      ],
      canonMatches: [
        { termKey: "direct-canon", entry: { files: [{ file: "memory/unselected-direct.md" }] } },
        { termKey: "selected-canon", entry: { files: [{ file: "house/memory/selected.md" }] } },
        { termKey: "rejected-canon", entry: { files: [{ file: "memory/rejected.md" }] } },
        {
          termKey: "alias-canon",
          entry: { aliases: ["Orchid Protocol"], files: [{ file: "memory/alias.md" }] },
        },
      ],
    }, { retrievalCandidateLimit: 24 });
    const session = createRecallViewportSession();
    session.exposures.set("rejected", 2);
    const viewport = automaticRecallViewport(compact, { session, saturationLimit: 2 });
    const filtered = filterCanonMatchesForCandidates(compact.canonMatches, {
      query: compact.query,
      candidates: viewport.keptCandidates,
    });

    expect(viewport.keptCandidates.map((item) => item.id)).toEqual(["selected"]);
    expect(filtered.map((match) => match.termKey)).toEqual([
      "direct-canon",
      "selected-canon",
      "alias-canon",
    ]);
  });
});
