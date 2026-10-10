// The parts of QuickJS's built-in `std` and `os` modules the platform uses.
// See https://bellard.org/quickjs/quickjs.html#Standard-library

declare const scriptArgs: string[];

declare module "std" {
  interface FILE {
    puts(s: string): void;
    write(buffer: ArrayBuffer, position: number, length: number): number;
    read(buffer: ArrayBuffer, position: number, length: number): number;
    readAsString(maxSize?: number): string;
    seek(offset: number, whence: number): number;
    fileno(): number;
    flush(): void;
    close(): number;
  }
  const out: FILE;
  const err: FILE;
  const SEEK_SET: number;
  function open(
    filename: string,
    flags: string,
    errorObj?: { errno?: number }
  ): FILE | null;
  function fdopen(fd: number, flags: string): FILE | null;
  function tmpfile(errorObj?: { errno?: number }): FILE | null;
  function getenv(name: string): string | undefined;
  function getenviron(): Record<string, string>;
  function exit(code: number): never;
  function strerror(errno: number): string;
}

// Not `declare module "os"`: @types/node already owns that name, so qjs.ts
// imports it and casts to this interface instead.
interface QuickJsOs {
  platform: string;
  WNOHANG: number;
  SIGTERM: number;
  S_IFMT: number;
  S_IFDIR: number;
  exec(args: string[], options?: QuickJsExecOptions): number;
  waitpid(pid: number, options: number): [number, number];
  kill(pid: number, signal: number): number;
  setTimeout(fn: () => void, ms: number): unknown;
  stat(path: string): [{ mode: number; size: number } | null, number];
  mkdir(path: string, mode?: number): number;
  remove(path: string): number;
  rename(oldPath: string, newPath: string): number;
}

type QuickJsExecOptions = {
  block?: boolean;
  usePath?: boolean;
  file?: string;
  cwd?: string;
  stdin?: number;
  stdout?: number;
  stderr?: number;
  env?: Record<string, string>;
};
