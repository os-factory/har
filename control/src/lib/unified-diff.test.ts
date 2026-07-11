import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from './unified-diff';

describe('parseUnifiedDiff', () => {
  it('groups hunks by file and assigns paired line numbers', () => {
    const files = parseUnifiedDiff(`diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -2,3 +2,4 @@
 const stable = true;
-const removed = false;
+const added = true;
+const another = true;
 export { stable };`);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: 'src/example.ts',
      oldPath: 'src/example.ts',
      lines: [
        { kind: 'meta', content: 'index 1111111..2222222 100644' },
        { kind: 'meta', content: '@@ -2,3 +2,4 @@' },
        { kind: 'context', content: 'const stable = true;', oldLine: 2, newLine: 2 },
        { kind: 'delete', content: 'const removed = false;', oldLine: 3 },
        { kind: 'add', content: 'const added = true;', newLine: 3 },
        { kind: 'add', content: 'const another = true;', newLine: 4 },
        { kind: 'context', content: 'export { stable };', oldLine: 4, newLine: 5 },
      ],
    });
  });

  it('preserves /dev/null changes and metadata-only files', () => {
    const files = parseUnifiedDiff(`diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1 @@
+export const created = true;
diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755`);

    expect(files[0]).toMatchObject({
      path: 'new.ts',
      lines: [{ kind: 'meta' }, { kind: 'meta' }, { kind: 'add', newLine: 1 }],
    });
    expect(files[1]).toMatchObject({
      path: 'Unknown file',
      lines: [
        { kind: 'meta', content: 'old mode 100644' },
        { kind: 'meta', content: 'new mode 100755' },
      ],
    });
  });
});
