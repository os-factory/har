'use client';

import { CopyCommand, CopyValue } from '@/components/copy-command';
import { Badge } from '@/components/ui/badge';
import { isAttestedProof, shortDigest, shortTraceId, type FactoryProof } from '@/lib/factory-proof';
import { proofVerifyCommand } from '@/lib/slot-commands';
import { shortSha } from '@/lib/slot-timeline';

function ProofFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function verdictVariant(verdict: string | null): 'success' | 'destructive' | 'secondary' {
  if (verdict === 'pass') return 'success';
  if (verdict === 'fail') return 'destructive';
  return 'secondary';
}

/**
 * The Factory Commits proof Mission Control received for a verified tree: verdict,
 * attestation digest, trust, policy (only when the trace named one), the stages the
 * policy required, and the trace. Shown on records only, so nothing here links a slot.
 */
export function FactoryProofFacts({ proof, compact = false }: { proof: FactoryProof; compact?: boolean }) {
  return (
    <div className="space-y-3" data-testid="factory-proof">
      <dl className={compact ? 'grid gap-3 sm:grid-cols-3' : 'grid gap-3 sm:grid-cols-2 lg:grid-cols-4'}>
        <ProofFact label="Verdict">
          <Badge variant={verdictVariant(proof.verdict)} data-testid="factory-proof-verdict">
            {proof.verdict ?? `no verdict (${proof.result})`}
          </Badge>
        </ProofFact>
        <ProofFact label="Attestation">
          {proof.attestationDigest ? (
            <CopyValue value={proof.attestationDigest} display={shortDigest(proof.attestationDigest)} label="attestation digest" />
          ) : (
            <span className="text-muted-foreground">none recorded</span>
          )}
        </ProofFact>
        <ProofFact label="Trust">
          <Badge variant="outline" title="Recorded by the agent's own har verify; no independent executor attests it.">
            {proof.trust}
          </Badge>
        </ProofFact>
        <ProofFact label="Trace">
          <CopyValue value={proof.traceId} display={shortTraceId(proof.traceId)} label="trace id" />
        </ProofFact>
        {proof.policy ? (
          <ProofFact label="Policy">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2">
              {proof.policy.id ? <code className="font-mono text-xs">{proof.policy.id}</code> : null}
              {proof.policy.digest ? (
                <CopyValue value={proof.policy.digest} display={shortDigest(proof.policy.digest)} label="policy digest" />
              ) : null}
            </span>
          </ProofFact>
        ) : null}
        <ProofFact label="Factory run (proof)">
          <code className="break-all font-mono text-xs" title="The validation id the proof names">{proof.factoryRunId}</code>
        </ProofFact>
        {proof.verifyRunId && proof.verifyRunId !== proof.factoryRunId ? (
          <ProofFact label="Verify run">
            <code className="break-all font-mono text-xs" title="Mission Control's record of the har env verify invocation">
              {proof.verifyRunId}
            </code>
          </ProofFact>
        ) : null}
        {proof.treeHash ? (
          <ProofFact label="Tree">
            <code className="font-mono text-xs" title={proof.treeHash}>
              {proof.treeHash.slice(0, 8)}
            </code>
          </ProofFact>
        ) : null}
      </dl>
      {proof.requiredStages.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Required by policy</p>
          <ul className="flex flex-wrap gap-1.5" aria-label="Stages required by policy" data-testid="factory-proof-required">
            {proof.stages
              .filter((stage) => stage.addedBy === 'policy')
              .map((stage) => {
                const ok = stage.result === 'success';
                return (
                  <li key={stage.name}>
                    <Badge variant={ok ? 'success' : 'destructive'} className="gap-1 font-mono text-[11px]">
                      {ok ? '✓' : '✗'} {stage.name}
                    </Badge>
                  </li>
                );
              })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A commit carries the proof when its tree is the tree an attested proof names.
 * Mission Control shows what it received; `har proof verify` checks the commit itself.
 */
export function CommitProof({
  proof,
  commitSha,
  commitTree,
  repositoryPath,
}: {
  proof: FactoryProof;
  commitSha: string;
  commitTree: string;
  repositoryPath: string | null;
}) {
  const attested = isAttestedProof(proof) && proof.treeHash === commitTree;
  return (
    <div className="space-y-3 rounded-md border bg-background/60 p-3" data-testid="commit-proof">
      <div className="text-sm">
        {attested ? (
          <>
            <Badge variant="success" className="mr-2">
              Proof attached
            </Badge>
            Commit <code className="font-mono text-xs">{shortSha(commitSha)}</code> has tree{' '}
            <code className="font-mono text-xs">{commitTree.slice(0, 8)}</code>, the tree the attestation names.
          </>
        ) : (
          <>
            <Badge variant="secondary" className="mr-2">
              No attestation
            </Badge>
            A verification of this tree was received, but it carries no attestation.
          </>
        )}
      </div>
      <FactoryProofFacts proof={proof} compact />
      {attested ? (
        <div className="space-y-1">
          <CopyCommand label="Check the proof" command={proofVerifyCommand(repositoryPath, commitSha)} />
          <p className="text-xs text-muted-foreground">Copy it into your terminal. Mission Control cannot run har itself.</p>
        </div>
      ) : null}
    </div>
  );
}
