// Adaptive presentation boundary for automatic recall.
// This module never changes the underlying recall query or explicit/manual recall.

const DEFAULT_GLUE_TERMS = [
  "a", "an", "and", "are", "as", "assignment", "at", "be", "below", "by", "can",
  "change", "create", "do", "for", "from", "how", "i", "in", "is", "it", "me",
  "my", "of", "on", "only", "or", "please", "read", "restart", "restarted",
  "review", "show", "target", "that", "the", "this", "to", "we", "what", "when",
  "where", "which", "with", "wonder", "work", "works", "you", "your",
];

const CLAIM_GLUE = new Set([
  ...DEFAULT_GLUE_TERMS,
  "about", "after", "all", "before", "candidate", "context", "evidence", "memory",
  "note", "recall", "record", "result", "said", "says", "source", "was", "were",
]);
const NON_DISTINCTIVE_EXACT_TERMS = new Set(["before", "change", "restarted", "review", "same", "tool", "tools", "wonder", "work", "works"]);
const NEGATION = /\b(?:cannot|can't|didn't|doesn't|false|never|no|not|refuted|without|won't|wrong)\b/i;
const CONFLICT = /\b(?:conflict|contradict|deprecated|disagree|outdated|refut|replaced|supersed)\w*\b/i;
const ISO_DATE = /(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?!\d)/;

const text = (value: unknown): string => value == null ? "" : String(value).trim();
const list = (value: unknown): string[] => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
const key = (value: unknown): string => text(value).toLocaleLowerCase();
const pathKey = (value: unknown): string => key(value).replace(/\\/g, "/").replace(/^house\//, "");

export const EVIDENCE_BUNDLE_LABELS = Object.freeze([
  "Evidence kind",
  "Title",
  "Authority state",
  "Lifecycle state",
  "Source / provenance",
  "Human date",
  "Selection reason",
  "Excerpt",
] as const);

type EvidenceLabel = typeof EVIDENCE_BUNDLE_LABELS[number];
export type RecallEvidenceBundle = Readonly<Record<EvidenceLabel, string>>;

function isDistinctiveExactTerm(value: unknown): boolean {
  const term = key(value);
  return term.length >= 7 && !NON_DISTINCTIVE_EXACT_TERMS.has(term);
}

function termIn(value: unknown, term: string): boolean {
  const haystack = key(value);
  const needle = key(term);
  if (!needle || needle.length < 2) return false;
  return haystack === needle || haystack.includes(needle);
}

export interface RecallViewportOptions {
  /** Terms which are conversational glue, rather than memory intent. */
  glueTerms?: string[];
  /** Number of distinct evidence signals required without an exact signal. */
  minIndependentSignals?: number;
  /** Number of automatic exposures allowed per candidate identity per session. */
  saturationLimit?: number;
  /** Hard bound on candidates inspected before adaptive selection. */
  maxPoolCandidates?: number;
  /** Hard bound on selected evidence bundles. */
  maxBundles?: number;
  /** Hard bound on excerpt characters across all selected bundles. */
  maxGlobalExcerptChars?: number;
  /** Optional session state; omit to use a fresh, one-call session. */
  session?: RecallViewportSession;
}

export interface RecallViewportSession {
  exposures: Map<string, number>;
}

export interface RecallSuppression {
  identity: string;
  reason: "zero-terms" | "glue-only" | "insufficient-evidence" | "saturated" | "outside-aperture";
}

interface CandidateAnalysis<T = any> {
  candidate: T;
  identity: string;
  rank: number;
  exact: Set<string>;
  meaningful: string[];
  claim: string;
  claimTokens: Set<string>;
  evidenceKind: string;
  authorityState: string;
  provenance: string;
  contradictory: boolean;
}

export interface RecallViewportDiagnostics {
  kept: number;
  suppressed: number;
  reasons: Record<string, number>;
  pool: { available: number; inspected: number; uninspected: number; hardLimit: number };
  aperture: {
    selectedBundles: number;
    bundleLimit: number;
    ambiguous: boolean;
    contradiction: boolean;
    authorityComplexity: boolean;
    distinctClaims: number;
    convergent: boolean;
    exactConvergent: boolean;
    sourceComplexity: number;
  };
  budget: { hardLimit: number; adaptedLimit: number; used: number; remaining: number };
  selection: Array<{ identity: string; rank: number; reason: string }>;
}

export interface RecallViewportResult<T = any> {
  candidates: T[];
  keptCandidates: T[];
  evidenceBundles: RecallEvidenceBundle[];
  suppressions: RecallSuppression[];
  diagnostics: RecallViewportDiagnostics;
}

export function createRecallViewportSession(): RecallViewportSession {
  return { exposures: new Map() };
}

function identityOf(candidate: any, index: number): string {
  const explicit = text(candidate?.id || candidate?.identity || candidate?.candidate_id);
  if (explicit) return explicit;
  const path = pathKey(candidate?.source_path);
  const title = key(candidate?.title);
  return path || title ? `${path}|${title}` : `candidate:${index}`;
}

function exactSignals(candidate: any, result: any, query: string): Set<string> {
  const signals = new Set<string>();
  const sources = list(candidate?.sources).map(key);
  const reasons = list(candidate?.reasons).map(key);
  const path = pathKey(candidate?.source_path);
  const title = text(candidate?.title);
  const terms = list(candidate?.matched_terms);
  const canon = Array.isArray(result?.canonMatches) ? result.canonMatches : [];
  if (sources.some((s) => s.includes("canon")) || reasons.some((s) => s.includes("canon")) || canon.some((m: any) => (Array.isArray(m?.files) && m.files.some((f: any) => pathKey(typeof f === "object" ? f?.file : f) === path)) || termIn(query, m?.termKey))) signals.add("canon");
  if (sources.some((s) => s.includes("entity")) || reasons.some((s) => s.includes("named entity"))) signals.add("entity");
  if (sources.some((s) => s.includes("date")) || (Array.isArray(result?.dateMatches) && result.dateMatches.some((d: any) => pathKey(d?.source_path) === path))) signals.add("date");
  if (sources.some((s) => s.includes("project")) || reasons.some((s) => s.includes("project"))) signals.add("project");
  if ((key(title).length >= 7 && termIn(query, title)) || terms.some((term) => isDistinctiveExactTerm(term) && termIn(title, term))) signals.add("title");
  if (terms.some((term) => isDistinctiveExactTerm(term) && termIn(path, term)) || (path.length >= 7 && termIn(query, path))) signals.add("path");
  return signals;
}

function meaningfulQueryTerms(query: string, glue: Set<string>): string[] {
  return key(query).match(/[\p{L}\p{N}_-]{2,}/gu)?.filter((term) => !glue.has(term)) || [];
}

function evidenceKind(candidate: any): string {
  const sources = list(candidate?.sources).map(key);
  if (sources.some((source) => source.includes("canon"))) return "Canonical evidence";
  if (sources.some((source) => source.includes("project_lesson") || source.includes("project lesson"))) return "Project lesson";
  if (sources.some((source) => source.includes("coding_lesson") || source.includes("coding lesson"))) return "Coding lesson";
  if (sources.some((source) => source.includes("date"))) return "Dated evidence";
  if (sources.some((source) => source.includes("memory"))) return "Memory";
  return "Retrieved evidence";
}

function authorityState(candidate: any, kind: string): string {
  const explicit = text(candidate?.authority_state || candidate?.authorityState || candidate?.authority);
  if (explicit) return explicit;
  if (kind === "Canonical evidence") return "Authoritative canon";
  if (kind === "Project lesson") return "Project-scoped authority";
  if (kind === "Coding lesson") return "Advisory instruction";
  if (kind === "Memory") return "Remembered account";
  return "Unverified retrieval";
}
function lifecycleState(candidate: any): string {
  const supersededBy = text(candidate?.superseded_by || candidate?.supersededBy);
  const archivedAt = text(candidate?.archived_at || candidate?.archivedAt);
  const states: string[] = [];
  if (candidate?.superseded || supersededBy) {
    states.push(supersededBy ? `Superseded by ${supersededBy}` : "Superseded");
  }
  if (candidate?.archived || archivedAt) {
    states.push(archivedAt ? `Archived ${archivedAt}` : "Archived");
  }
  if (states.length) return states.join("; ");
  if (candidate?.historical) return "Historical retrieval";
  return "Active";
}

function provenanceOf(candidate: any): string {
  const path = text(candidate?.source_path) || "Inline evidence";
  const sources = list(candidate?.sources);
  return sources.length ? `${path} · ${sources.join(" + ")}` : path;
}

function claimOf(candidate: any): string {
  const raw = text(candidate?.claim || candidate?.title || text(candidate?.excerpt).split(/(?<=[.!?])\s+/u)[0]);
  const terms = key(raw).match(/[\p{L}\p{N}_-]{3,}/gu) || [];
  const distinctive = terms.filter((term) => !CLAIM_GLUE.has(term) && !NEGATION.test(term));
  return distinctive.slice(0, 10).join(" ") || terms.slice(0, 10).join(" ") || pathKey(candidate?.source_path);
}

function tokenSet(value: string): Set<string> {
  return new Set(value.split(/\s+/).filter(Boolean));
}

function similarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  left.forEach((term) => { if (right.has(term)) overlap += 1; });
  return overlap / Math.min(left.size, right.size);
}

function hasContradiction(candidates: CandidateAnalysis[]): boolean {
  if (candidates.some((analysis) => analysis.contradictory)) return true;
  for (let left = 0; left < candidates.length; left += 1) {
    const leftText = `${text((candidates[left].candidate as any)?.title)} ${text((candidates[left].candidate as any)?.excerpt)}`;
    for (let right = left + 1; right < candidates.length; right += 1) {
      const rightText = `${text((candidates[right].candidate as any)?.title)} ${text((candidates[right].candidate as any)?.excerpt)}`;
      if (NEGATION.test(leftText) !== NEGATION.test(rightText) && similarity(candidates[left].claimTokens, candidates[right].claimTokens) >= 0.5) return true;
    }
  }
  return false;
}

function exactCandidatesMutuallyConverge(candidates: CandidateAnalysis[]): boolean {
  if (candidates.length < 2) return false;
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      const sharedExactSignal = [...candidates[left].exact]
        .some((signal) => candidates[right].exact.has(signal));
      if (!sharedExactSignal || similarity(candidates[left].claimTokens, candidates[right].claimTokens) < 0.5) {
        return false;
      }
    }
  }
  return true;
}

function coverageOf(candidate: any): number | null {
  if (typeof candidate?.term_coverage === "number" && Number.isFinite(candidate.term_coverage)) return candidate.term_coverage;
  const matched = Number(candidate?.term_coverage?.matched);
  const total = Number(candidate?.term_coverage?.total);
  return Number.isFinite(matched) && Number.isFinite(total) && total > 0 ? matched / total : null;
}

function nonlinearPoolLimit(available: number, hardLimit: number): number {
  if (available <= 6) return Math.min(available, hardLimit);
  const nonlinear = 6 + Math.ceil(Math.sqrt(available - 6) * 4);
  return Math.min(available, hardLimit, nonlinear);
}

function formatHumanDate(candidate: any): string {
  const direct = text(candidate?.human_date || candidate?.date || candidate?.occurred_on || candidate?.created_at || candidate?.updated_at);
  const raw = direct || [candidate?.source_path, candidate?.title, candidate?.excerpt].map(text).join(" ");
  const match = ISO_DATE.exec(raw);
  if (!match) return direct || "Undated";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(date);
}

function clipAtSentenceBoundary(value: unknown, allowance: number): string {
  const source = text(value).replace(/\s+/g, " ");
  if (allowance <= 0 || !source) return "";
  if (source.length <= allowance) return source;
  if (allowance === 1) return "…";
  const window = source.slice(0, allowance);
  const sentence = [...window.matchAll(/[.!?](?=\s|$)/g)].at(-1);
  if (sentence && sentence.index !== undefined) {
    return window.slice(0, sentence.index + 1).trimEnd();
  }
  const word = window.slice(0, allowance - 1).lastIndexOf(" ");
  const end = word >= Math.floor(allowance * 0.4) ? word : allowance - 1;
  return `${window.slice(0, end).trimEnd()}…`;
}

function selectionReason(
  analysis: CandidateAnalysis,
  selected: CandidateAnalysis[],
  signals: { contradiction: boolean; exactConvergent: boolean },
): string {
  const reasons: string[] = [];
  if (!selected.length) reasons.push("highest-ranked eligible evidence");
  if (analysis.exact.size) reasons.push(`exact ${[...analysis.exact].sort().join("/")} signal`);
  if (selected.length && !selected.some((item) => item.claim === analysis.claim)) reasons.push("distinct claim");
  if (selected.length && !selected.some((item) => item.authorityState === analysis.authorityState)) reasons.push("authority contrast");
  if (selected.length && !selected.some((item) => item.evidenceKind === analysis.evidenceKind)) reasons.push("source diversity");
  if (signals.contradiction && analysis.contradictory) reasons.push("possible contradiction");
  if (signals.exactConvergent) reasons.push("exact convergent evidence contracted aperture");
  return reasons.length ? reasons.join("; ") : "ranked relevant evidence";
}

function chooseCandidates(
  eligible: CandidateAnalysis[],
  bundleLimit: number,
  signals: { contradiction: boolean; exactConvergent: boolean },
): Array<{ analysis: CandidateAnalysis; reason: string }> {
  const remaining = [...eligible];
  const selected: Array<{ analysis: CandidateAnalysis; reason: string }> = [];
  while (selected.length < bundleLimit && remaining.length) {
    const selectedAnalyses = selected.map((entry) => entry.analysis);
    remaining.sort((left, right) => {
      const utility = (item: CandidateAnalysis) => {
        let value = 4 / (item.rank + 1) + item.exact.size * 0.8;
        if (!selectedAnalyses.some((selectedItem) => selectedItem.claim === item.claim)) value += 1.5;
        if (!selectedAnalyses.some((selectedItem) => selectedItem.authorityState === item.authorityState)) value += 0.55;
        if (!selectedAnalyses.some((selectedItem) => selectedItem.evidenceKind === item.evidenceKind)) value += 0.45;
        if (signals.contradiction && item.contradictory) value += 0.5;
        return value;
      };
      return utility(right) - utility(left) || left.rank - right.rank;
    });
    const analysis = remaining.shift()!;
    selected.push({ analysis, reason: selectionReason(analysis, selectedAnalyses, signals) });
  }
  return selected;
}

function bundleFor(analysis: CandidateAnalysis, reason: string, excerpt: string): RecallEvidenceBundle {
  return Object.freeze({
    "Evidence kind": analysis.evidenceKind,
    "Title": text((analysis.candidate as any)?.title) || "Untitled evidence",
    "Authority state": analysis.authorityState,
    "Lifecycle state": lifecycleState(analysis.candidate),
    "Source / provenance": analysis.provenance,
    "Human date": formatHumanDate(analysis.candidate),
    "Selection reason": reason,
    "Excerpt": excerpt,
  });
}

/** Filter and adapt compact results for automatic injection. Explicit recall remains untouched. */
export function automaticRecallViewport<T = any>(result: any, options: RecallViewportOptions = {}): RecallViewportResult<T> {
  const candidates: T[] = Array.isArray(result?.retrievalCandidates) ? result.retrievalCandidates : [];
  const glue = new Set((options.glueTerms || DEFAULT_GLUE_TERMS).map(key));
  const minimum = Math.max(1, options.minIndependentSignals ?? 2);
  const saturationLimit = Math.max(1, options.saturationLimit ?? 2);
  const hardPoolLimit = Math.max(1, Math.min(32, Math.floor(options.maxPoolCandidates ?? 24)));
  const inspectedCount = nonlinearPoolLimit(candidates.length, hardPoolLimit);
  const inspected = candidates.slice(0, inspectedCount);
  const session = options.session || createRecallViewportSession();
  const query = text(result?.query);
  const suppressions: RecallSuppression[] = [];
  const eligible: CandidateAnalysis<T>[] = [];

  inspected.forEach((candidate: any, rank: number) => {
    const identity = identityOf(candidate, rank);
    const matched = list(candidate?.matched_terms);
    const meaningful = matched.filter((term) => !glue.has(key(term)));
    let reason: RecallSuppression["reason"] | null = null;
    if (!matched.length) reason = "zero-terms";
    else if (!meaningful.length) reason = "glue-only";
    const exact = exactSignals(candidate, result, query);
    const independent = new Set(meaningful.map(key));
    exact.forEach((signal) => independent.add(`exact:${signal}`));
    if (!reason && exact.size === 0 && independent.size < minimum) reason = "insufficient-evidence";
    const exposed = session.exposures.get(identity) || 0;
    if (!reason && exposed >= saturationLimit) reason = "saturated";
    if (reason) {
      suppressions.push({ identity, reason });
      return;
    }
    const kind = evidenceKind(candidate);
    const claim = claimOf(candidate);
    eligible.push({
      candidate,
      identity,
      rank,
      exact,
      meaningful,
      claim,
      claimTokens: tokenSet(claim),
      evidenceKind: kind,
      authorityState: authorityState(candidate, kind),
      provenance: provenanceOf(candidate),
      contradictory: CONFLICT.test(`${text(candidate?.title)} ${list(candidate?.reasons).join(" ")} ${text(candidate?.excerpt)}`),
    });
  });

  const distinctClaims = new Set(eligible.map((candidate) => candidate.claim || candidate.identity)).size;
  const authorities = new Set(eligible.map((candidate) => candidate.authorityState));
  const kinds = new Set(eligible.map((candidate) => candidate.evidenceKind));
  const sourceRoots = new Set(eligible.map((candidate) => pathKey((candidate.candidate as any)?.source_path).split("/")[0]).filter(Boolean));
  const sourceComplexity = kinds.size + Math.min(2, sourceRoots.size);
  const contradiction = hasContradiction(eligible);
  const authorityComplexity = authorities.size > 1;
  const convergenceStates = new Set(
    eligible.map((candidate) => `${candidate.claim || candidate.identity}|${candidate.authorityState}|${candidate.evidenceKind}`),
  );
  const convergent = eligible.length > 0 && convergenceStates.size <= Math.max(1, Math.floor(eligible.length / 2));
  const exactCandidates = eligible.filter((candidate) => candidate.exact.size > 0);
  const hasExact = exactCandidates.length > 0;
  const exactConvergent = exactCandidates.length >= 2
    && exactCandidates.length === eligible.length
    && !contradiction
    && exactCandidatesMutuallyConverge(exactCandidates);
  const coverages = eligible.map((candidate) => coverageOf(candidate.candidate)).filter((value): value is number => value !== null);
  const averageCoverage = coverages.length ? coverages.reduce((sum, value) => sum + value, 0) / coverages.length : 1;
  const ambiguous = !hasExact && eligible.length > 1 && (
    meaningfulQueryTerms(query, glue).length <= 1
    || distinctClaims >= 4
    || averageCoverage < 0.5
  );

  const hardBundleLimit = Math.max(1, Math.min(12, Math.floor(options.maxBundles ?? 8)));
  let bundleLimit = Math.min(2, eligible.length);
  if (ambiguous) bundleLimit += 2;
  if (contradiction) bundleLimit += 2;
  if (authorityComplexity) bundleLimit += 1;
  if (distinctClaims > 2) bundleLimit += Math.min(2, distinctClaims - 2);
  if (sourceComplexity > 3) bundleLimit += 1;
  if (convergent) bundleLimit = Math.max(Math.min(2, eligible.length), bundleLimit - 1);
  if (exactConvergent) bundleLimit = 1;
  bundleLimit = Math.min(eligible.length, hardBundleLimit, bundleLimit);

  const selected = chooseCandidates(eligible, bundleLimit, { contradiction, exactConvergent });
  const selectedIdentities = new Set(selected.map(({ analysis }) => analysis.identity));
  eligible.forEach(({ identity }) => {
    if (!selectedIdentities.has(identity)) suppressions.push({ identity, reason: "outside-aperture" });
  });
  selected.forEach(({ analysis }) => {
    session.exposures.set(analysis.identity, (session.exposures.get(analysis.identity) || 0) + 1);
  });

  const hardBudget = Math.max(0, Math.floor(options.maxGlobalExcerptChars ?? 3600));
  let adaptedBudget = 900 + Math.max(0, bundleLimit - 2) * 240;
  if (ambiguous) adaptedBudget += 420;
  if (contradiction) adaptedBudget += 420;
  if (authorityComplexity) adaptedBudget += 180;
  if (distinctClaims > 2) adaptedBudget += Math.min(480, (distinctClaims - 2) * 120);
  if (sourceComplexity > 3) adaptedBudget += 240;
  if (convergent) adaptedBudget -= 240;
  if (exactConvergent) adaptedBudget = Math.min(adaptedBudget, 660);
  adaptedBudget = Math.min(hardBudget, Math.max(Math.min(320, hardBudget), adaptedBudget));
  if (!selected.length) adaptedBudget = 0;

  let remainingBudget = adaptedBudget;
  const evidenceBundles = selected.map(({ analysis, reason }, index) => {
    const remainingBundles = selected.length - index;
    const allowance = Math.min(900, Math.floor(remainingBudget / remainingBundles));
    const excerpt = clipAtSentenceBoundary((analysis.candidate as any)?.excerpt, allowance);
    remainingBudget -= excerpt.length;
    return bundleFor(analysis, reason, excerpt);
  });
  const usedBudget = adaptedBudget - remainingBudget;
  const keptCandidates = selected.map(({ analysis }) => analysis.candidate);
  const reasons: Record<string, number> = {};
  suppressions.forEach(({ reason }) => { reasons[reason] = (reasons[reason] || 0) + 1; });
  const diagnostics: RecallViewportDiagnostics = {
    kept: keptCandidates.length,
    suppressed: suppressions.length,
    reasons,
    pool: {
      available: candidates.length,
      inspected: inspectedCount,
      uninspected: candidates.length - inspectedCount,
      hardLimit: hardPoolLimit,
    },
    aperture: {
      selectedBundles: keptCandidates.length,
      bundleLimit,
      ambiguous,
      contradiction,
      authorityComplexity,
      distinctClaims,
      convergent,
      exactConvergent,
      sourceComplexity,
    },
    budget: {
      hardLimit: hardBudget,
      adaptedLimit: adaptedBudget,
      used: usedBudget,
      remaining: remainingBudget,
    },
    selection: selected.map(({ analysis, reason }) => ({ identity: analysis.identity, rank: analysis.rank, reason })),
  };
  return { candidates: keptCandidates, keptCandidates, evidenceBundles, suppressions, diagnostics };
}

export default automaticRecallViewport;
