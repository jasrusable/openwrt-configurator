// POSIX path helpers. Device paths are always POSIX, and the workstation side
// runs on macOS or Linux, so `path.posix` semantics are all that is needed.

export const dirname = (path: string) => {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") {
    return path.startsWith("/") ? "/" : ".";
  }
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? "." : slash === 0 ? "/" : trimmed.slice(0, slash);
};

export const join = (...parts: string[]) =>
  parts
    .filter((part) => part.length > 0)
    .join("/")
    .replace(/\/{2,}/g, "/");
