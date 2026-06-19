import { runCli } from './cli';

runCli().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
