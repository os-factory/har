/**
 * The harness runtime, package-side (#234). One implementation of launch /
 * teardown / setup-infra / verify / per-slot ops; the generated .har/*.sh
 * files are argument-preserving delegates into `har env` (#235 pins their
 * npx fallback). Capability checks default to file/manifest presence until
 * #236 supplies capability manifests.
 */
export * from './exec';
export * from './node-pm';
export * from './provision';
export * from './worktree';
export * from './agent-env';
export * from './infra';
export * from './process';
export * from './xcode-sim';
export * from './launch';
export * from './teardown';
export * from './setup';
export * from './verify';
export * from './agent-ops';
