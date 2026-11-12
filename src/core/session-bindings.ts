import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  SessionSlotBindingSchema,
  deriveOccupancyKey,
  launchingAgentSession,
  type SessionSlotBinding,
  type SlotRegistryEntry,
} from '../harness/schema';
import { markDirty } from './sync-context';

/**
 * `launch` / `release` evidence for session → slot attribution (ADR 0003).
 *
 * `har env launch`, `teardown` and `complete` (CLI and MCP share the run
 * service) record which agent session ran them, read from the env var its agent
 * gives every command (`AGENT_SESSION_ENV`). Bindings are kept in their own
 * ledger, `.har/session-bindings/`, not on the slot record: teardown deletes the
 * record and the next launch overwrites it, so a binding stored there would be
 * lost before `har control sync` posts it. One file per binding, named by its
 * idempotency key, so recording twice is a no-op.
 */

export const SESSION_BINDINGS_DIR = 'session-bindings';

type OccupancySource = Pick<
  SlotRegistryEntry,
  'attemptId' | 'branch' | 'createdAt' | 'worktreePath' | 'workDir'
>;

/**
 * The occupancy key Mission Control derives for this slot record (#316): the
 * shared `deriveOccupancyKey` applied to the record as an active slot.
 */
export function slotOccupancyKey(session: OccupancySource): string | undefined {
  return (
    deriveOccupancyKey({
      active: true,
      attemptId: session.attemptId,
      branch: session.branch,
      sessionCreatedAt: session.createdAt,
      worktreePath: session.worktreePath,
      workDir: session.workDir,
    }) ?? undefined
  );
}

/** The idempotency tuple Mission Control upserts bindings on. */
export function sessionBindingKey(binding: SessionSlotBinding): string {
  return [
    binding.agentTool,
    binding.sessionId,
    binding.subagentId ?? '',
    binding.kind,
    String(binding.slotId),
    binding.at,
  ].join('\0');
}

function bindingsDir(harnessRoot: string): string {
  return path.join(harnessRoot, '.har', SESSION_BINDINGS_DIR);
}

function bindingPath(harnessRoot: string, binding: SessionSlotBinding): string {
  const digest = crypto.createHash('sha256').update(sessionBindingKey(binding)).digest('hex');
  return path.join(bindingsDir(harnessRoot), `${digest}.json`);
}

function ensureSessionBindingsIgnored(harnessRoot: string): void {
  const harDir = path.join(harnessRoot, '.har');
  if (!fs.existsSync(harDir)) return;
  const gitignorePath = path.join(harDir, '.gitignore');
  const content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  if (content.split('\n').some((line) => line.trim() === `${SESSION_BINDINGS_DIR}/`)) return;
  const suffix = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(gitignorePath, `${content}${suffix}${SESSION_BINDINGS_DIR}/\n`);
}

export function recordSessionBinding(
  harnessRoot: string,
  input: SessionSlotBinding,
): SessionSlotBinding {
  const binding = SessionSlotBindingSchema.parse(input);
  ensureSessionBindingsIgnored(harnessRoot);
  const file = bindingPath(harnessRoot, binding);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(binding, null, 2)}\n`);
    fs.renameSync(temp, file);
    markDirty(harnessRoot);
  }
  return binding;
}

/** Bindings recorded under one harness root, oldest first. */
export function listSessionBindings(harnessRoot: string): SessionSlotBinding[] {
  const dir = bindingsDir(harnessRoot);
  if (!fs.existsSync(dir)) return [];
  const out: SessionSlotBinding[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = SessionSlotBindingSchema.safeParse(
        JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')),
      );
      if (parsed.success) out.push(parsed.data);
    } catch {
      // skip unreadable records
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

type Env = Readonly<Record<string, string | undefined>>;

function slotFields(
  session: SlotRegistryEntry,
): Pick<SessionSlotBinding, 'slotId' | 'occupancyKey' | 'branch'> {
  const occupancyKey = slotOccupancyKey(session);
  return {
    slotId: session.agentId,
    ...(occupancyKey ? { occupancyKey } : {}),
    ...(session.branch ? { branch: session.branch } : {}),
  };
}

/**
 * `launch` binding for the agent session that ran the launch, or null when the
 * launch did not run inside an agent.
 */
export function recordLaunchBinding(options: {
  harnessRoot: string;
  session: SlotRegistryEntry;
  env?: Env;
  at?: string;
}): SessionSlotBinding | null {
  const agent = launchingAgentSession(options.env ?? process.env);
  if (!agent) return null;
  return recordSessionBinding(options.harnessRoot, {
    ...agent,
    kind: 'launch',
    ...slotFields(options.session),
    at: options.at ?? new Date().toISOString(),
  });
}

/**
 * `release` bindings when a slot occupancy ends (teardown, complete): for the
 * agent session running the command, and for every session that launched this
 * occupancy — a human tearing down from a terminal still closes the launching
 * agent's binding.
 */
export function recordReleaseBindings(options: {
  harnessRoot: string;
  session: SlotRegistryEntry;
  env?: Env;
  at?: string;
}): SessionSlotBinding[] {
  const at = options.at ?? new Date().toISOString();
  const fields = slotFields(options.session);
  const sessions = new Map<
    string,
    { agentTool: SessionSlotBinding['agentTool']; sessionId: string }
  >();
  const current = launchingAgentSession(options.env ?? process.env);
  if (current) sessions.set(`${current.agentTool}\0${current.sessionId}`, current);
  for (const binding of listSessionBindings(options.harnessRoot)) {
    if (binding.kind !== 'launch' || binding.slotId !== fields.slotId) continue;
    if ((binding.occupancyKey ?? null) !== (fields.occupancyKey ?? null)) continue;
    sessions.set(`${binding.agentTool}\0${binding.sessionId}`, {
      agentTool: binding.agentTool,
      sessionId: binding.sessionId,
    });
  }
  return [...sessions.values()].map((agent) =>
    recordSessionBinding(options.harnessRoot, { ...agent, kind: 'release', ...fields, at }),
  );
}
