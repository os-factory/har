# Shared helpers for external-worktree line stages.
now_ms() { node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo 0; }
escape_step_output() {
  printf '%s' "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const s=d.trim().split('\n').slice(0,50).join('\n');process.stdout.write(JSON.stringify(s))})" 2>/dev/null || echo '""'
}
emit_result() { # stage_id status agent_id total_ms output
  node -e "process.stdout.write(JSON.stringify({
    status: '$2', stageId: '$1', kind: 'test', agent_id: $3, total_ms: $4, output: $5
  }, null, 2) + '\n');"
}
