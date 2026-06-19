import chalk from 'chalk';

export function info(msg: string): void {
  console.error(chalk.blue('==>') + ' ' + msg);
}

export function success(msg: string): void {
  console.error(chalk.green('✓') + ' ' + msg);
}

export function warn(msg: string): void {
  console.error(chalk.yellow('⚠') + ' ' + msg);
}

export function error(msg: string): void {
  console.error(chalk.red('✗') + ' ' + msg);
}

export function step(msg: string): void {
  console.error(chalk.dim('  →') + ' ' + msg);
}

export function header(msg: string): void {
  console.error('\n' + chalk.bold(msg));
}

export function divider(): void {
  console.error(chalk.dim('─'.repeat(60)));
}
