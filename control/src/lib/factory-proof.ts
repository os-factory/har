/**
 * Factory Commits proofs as Mission Control shows them.
 *
 * A full `har env verify` sends one verification trace (stored as a
 * `VerificationRun` with its `VerificationStage` rows). When the tree verified
 * there, its run span carries the verdict, the tree hash and the digest of the
 * attestation HAR wrote for that tree. This module turns those rows into the
 * record a work-unit page shows, and ties them to the rest of the record:
 *
 * - the **verify run** is Mission Control's per-invocation record (`Run.runId`);
 * - the **Factory run (proof)** is the validation id the proof names
 *   (`VerificationRun.runId`, `cicd.pipeline.run.id`).
 *
 * They are different ids. A snapshot (`ChangeBatch`) carries both, so it is the join.
 */

/** HAR 2.0 records every local verify as self-reported (SPEC §11); nothing independent attests it yet. */
export const FACTORY_PROOF_TRUST = 'self-reported';

export interface FactoryProofStage {
  name: string;
  result: string;
  /** `factory.stage.added_by`: `policy` when the policy requires the stage, `agent` when the agent added it. */
  addedBy: string | null;
}

export interface FactoryProof {
  /** The validation id the proof names: `VerificationRun.runId`. */
  factoryRunId: string;
  /** Mission Control's verify run for the same verification, when a snapshot ties them. */
  verifyRunId: string | null;
  traceId: string;
  pipelineName: string;
  /** `cicd.pipeline.result`. */
  result: string;
  /** `factory.verdict` (full verify only). */
  verdict: string | null;
  treeHash: string | null;
  attestationDigest: string | null;
  trust: typeof FACTORY_PROOF_TRUST;
  /** Only what the run span carried; null when it named no policy. */
  policy: { id: string | null; digest: string | null } | null;
  /** Stage ids the trace marks as required by the policy. */
  requiredStages: string[];
  stages: FactoryProofStage[];
  producerVersion: string | null;
  /** ISO */
  startTime: string;
}

export interface FactoryProofSource {
  runId: string;
  traceId: string;
  pipelineName: string;
  result: string;
  verdict: string | null;
  treeHash: string | null;
  attestationDigest: string | null;
  policyId: string | null;
  policyDigest: string | null;
  producerVersion: string | null;
  startTime: Date;
  stages: Array<{ name: string; result: string; addedBy: string | null }>;
}

/**
 * One stored verification run as a proof. `verifyRunIdByValidation` maps a
 * validation id to the verify run a snapshot recorded for it; `verifyRunIds`
 * are the record's verify runs, for traces sent before a validation id existed
 * (their `runId` is then the verify run itself).
 */
export function toFactoryProof(
  source: FactoryProofSource,
  verifyRunIdByValidation: ReadonlyMap<string, string | null>,
  verifyRunIds: ReadonlySet<string> = new Set(),
): FactoryProof {
  const verifyRunId =
    verifyRunIdByValidation.get(source.runId) ?? (verifyRunIds.has(source.runId) ? source.runId : null);
  const policy =
    source.policyId || source.policyDigest ? { id: source.policyId, digest: source.policyDigest } : null;
  return {
    factoryRunId: source.runId,
    verifyRunId,
    traceId: source.traceId,
    pipelineName: source.pipelineName,
    result: source.result,
    verdict: source.verdict,
    treeHash: source.treeHash,
    attestationDigest: source.attestationDigest,
    trust: FACTORY_PROOF_TRUST,
    policy,
    requiredStages: source.stages.filter((stage) => stage.addedBy === 'policy').map((stage) => stage.name),
    stages: source.stages.map((stage) => ({ name: stage.name, result: stage.result, addedBy: stage.addedBy })),
    producerVersion: source.producerVersion,
    startTime: source.startTime.toISOString(),
  };
}

/** A proof that attests its tree: a verdict and an attestation digest. */
export function isAttestedProof(proof: FactoryProof): boolean {
  return Boolean(proof.attestationDigest && proof.treeHash && proof.verdict);
}

/** The proof shown for a tree: the newest attested one, else the newest one. */
export function proofForTree(proofs: FactoryProof[], treeHash: string | null | undefined): FactoryProof | null {
  if (!treeHash) return null;
  const matches = proofs.filter((proof) => proof.treeHash === treeHash);
  return matches.find(isAttestedProof) ?? matches[0] ?? null;
}

/** The proof of one verify run (Mission Control's run id). */
export function proofForVerifyRun(proofs: FactoryProof[], verifyRunId: string | null | undefined): FactoryProof | null {
  if (!verifyRunId) return null;
  return proofs.find((proof) => proof.verifyRunId === verifyRunId) ?? null;
}

/** The proof a record leads with: newest attested, else newest. Proofs are newest first. */
export function headlineProof(proofs: FactoryProof[]): FactoryProof | null {
  return proofs.find(isAttestedProof) ?? proofs[0] ?? null;
}

/** `sha256:6b69ffb1…` style: algorithm plus the first 8 hex digits. */
export function shortDigest(digest: string): string {
  const [algo, hex] = digest.includes(':') ? digest.split(':', 2) : ['', digest];
  const short = hex.length > 8 ? `${hex.slice(0, 8)}…` : hex;
  return algo ? `${algo}:${short}` : short;
}

export function shortTraceId(traceId: string): string {
  return traceId.length > 8 ? `${traceId.slice(0, 8)}…` : traceId;
}
