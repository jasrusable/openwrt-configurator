// QuickJS's built-in modules, typed. @types/node owns the name "os", so
// QuickJS's `os` is described by the global QuickJsOs interface and cast here.
import * as osModule from "os";

export const os = osModule as unknown as QuickJsOs;

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => os.setTimeout(resolve, ms));

export const fileExists = (path: string) => os.stat(path)[0] !== null;
