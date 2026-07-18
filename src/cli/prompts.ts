// Interactive terminal prompts for the CLI, over @clack/prompts — one consistent style for
// text, secrets, yes/no, and pick-one. Two contracts live here so every call site shares them:
//   • non-interactive (no TTY): return `undefined` instead of blocking, so scripted use falls
//     back to flags/args (the caller validates required values and errors cleanly).
//   • cancel (Ctrl-C / Esc): exit the whole CLI — a half-answered prompt is never a result.
// Secrets typed here never touch argv or shell history (the reason a prompt exists at all).

import { cancel, confirm, isCancel, type Option, password, select, text } from "@clack/prompts";

/** Can we actually run an interactive prompt? Both ends must be a TTY. */
export function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Unwrap a clack answer, exiting cleanly if the user cancelled. */
function unwrap<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Cancelled.");
    process.exit(130); // 128 + SIGINT, the shell's convention for a Ctrl-C abort
  }
  return value as T;
}

/** Ask for a line of visible text. `undefined` when non-interactive. */
export async function askText(
  message: string,
  opts: { placeholder?: string; validate?: (value: string) => string | undefined } = {},
): Promise<string | undefined> {
  if (!interactive()) return undefined;
  return unwrap(
    await text({
      message,
      placeholder: opts.placeholder,
      validate: opts.validate ? (v) => opts.validate!(v ?? "") : undefined,
    }),
  );
}

/** Ask for a secret without echoing it. `undefined` when non-interactive. */
export async function askPassword(message: string): Promise<string | undefined> {
  if (!interactive()) return undefined;
  return unwrap(
    await password({
      message,
      validate: (v) => (v && v.length > 0 ? undefined : "required"),
    }),
  );
}

/** Ask a yes/no question (defaults to No — these guard destructive actions). `undefined` when non-interactive. */
export async function askConfirm(message: string): Promise<boolean | undefined> {
  if (!interactive()) return undefined;
  return unwrap(await confirm({ message, initialValue: false }));
}

/** One option in a {@link askSelect} list: the returned `value` plus how it's shown. */
export interface SelectOption<T> {
  value: T;
  label: string;
  hint?: string;
}

/** Pick one option from a list. `undefined` when non-interactive. */
export async function askSelect<T extends string>(
  message: string,
  options: SelectOption<T>[],
): Promise<T | undefined> {
  if (!interactive()) return undefined;
  // The field names match clack's `Option`; the cast only bridges its conditional type,
  // which doesn't reduce over a generic parameter.
  return unwrap(await select({ message, options: options as Option<T>[] })) as T;
}
