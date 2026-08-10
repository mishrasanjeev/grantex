import { readFileSync } from 'node:fs';

export interface TokenInputOptions {
  file?: string;
  stdin?: boolean;
  env?: string;
}

/** Read a grant token from exactly one argument, file, stdin, or environment variable. */
export function readTokenInput(
  tokenArg: string | undefined,
  opts: TokenInputOptions,
): string {
  const selected = [
    tokenArg !== undefined ? 'argument' : undefined,
    opts.file !== undefined ? 'file' : undefined,
    opts.stdin ? 'stdin' : undefined,
    opts.env !== undefined ? 'environment variable' : undefined,
  ].filter((source): source is string => source !== undefined);

  if (selected.length > 1) {
    throw new Error(`Provide exactly one token source; received ${selected.join(', ')}.`);
  }

  let token: string | undefined;
  if (opts.stdin) {
    // Numeric descriptor 0 works on Windows, macOS, and Linux.
    token = readFileSync(0, 'utf8');
  } else if (opts.file) {
    token = readFileSync(opts.file, 'utf8');
  } else if (opts.env) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.env)) {
      throw new Error(`Invalid environment variable name: ${opts.env}`);
    }
    token = process.env[opts.env];
    if (token === undefined) {
      throw new Error(`Environment variable ${opts.env} is not set.`);
    }
  } else {
    token = tokenArg;
  }

  const trimmed = token?.trim();
  if (!trimmed) {
    throw new Error(
      'No token provided. Pass a token argument, file, stdin, or environment variable.',
    );
  }
  return trimmed;
}
