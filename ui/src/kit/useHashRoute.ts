import { useEffect, useState } from "react";

/**
 * The current page, from the URL's hash. A hash works wherever the UI is
 * mounted — / on a Mac, /cgi-bin/onc/ on a router — with no server routes.
 */
export const useHashRoute = <T extends string>(routes: readonly T[], fallback: T) => {
  const read = () => {
    const hash = window.location.hash.replace(/^#\/?/, "") as T;
    return routes.includes(hash) ? hash : fallback;
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  });
  return [route, (next: T) => (window.location.hash = `/${next}`)] as const;
};
