import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Runs a program with arguments and resolves with its trimmed stdout.
 * Tools receive one of these instead of calling `execFile` directly, so the
 * agent can swap in a no-op runner during simulations.
 */
export type CommandRunner = (command: string, args: string[]) => Promise<string>;

// `execFile` passes arguments straight to the program without a shell, so text
// coming from the LLM (app names, search queries) can't inject extra commands.
export const runCommand: CommandRunner = async (command, args) => {
  const { stdout } = await execFileAsync(command, args, { timeout: 10_000 });
  return stdout.trim();
};

// Used under `lk agent simulate`, which runs the agent on this machine: the
// tools still run their logic, but nothing actually opens or changes volume.
export const dryRunCommand: CommandRunner = async (command, args) => {
  console.log(`[dry run] ${command} ${args.join(' ')}`);
  return '';
};
