## Do not

- Work around a failing harness command with ad-hoc setup — fix the harness or report the failure
- Edit `.env.agent.<id>` by hand
- Run `verify` before `launch` when e2e needs a running server
- Edit the main checkout — all edits go under the session work dir
