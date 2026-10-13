import test from "ava";
import { cgiRequest } from "../../server/cgi";
import { cgiResponse } from "../../server/handlers";

const names = ["gateway", "gateway.lan", "openwrt.lan"];
// Only what uhttpd passes (verified on 25.12.5): no X-ONC, no X-ONC-Version.
const request = (env: Record<string, string>) =>
  cgiRequest((name) => env[name], names, () => "{}");

test("under uhttpd, the CSRF check is the browser's Origin against Host", (t) => {
  const write = { REQUEST_METHOD: "PUT", PATH_INFO: "/api/intent", HTTP_HOST: "10.0.0.1", CONTENT_LENGTH: "2" };
  const ok = request({ ...write, HTTP_ORIGIN: "https://10.0.0.1" });
  t.false("refused" in ok);
  t.is((ok as { headers: Record<string, string> }).headers["x-onc"], "1");
  const cross = request({ ...write, HTTP_ORIGIN: "https://evil.example" }) as { headers: Record<string, string> };
  t.is(cross.headers["x-onc"], "", "another site's write");
  t.is((request(write) as { headers: Record<string, string> }).headers["x-onc"], "", "a write without Origin");
  const read = request({ REQUEST_METHOD: "GET", PATH_INFO: "/api/intent", HTTP_HOST: "gateway.lan" }) as { headers: Record<string, string> };
  t.is(read.headers["x-onc"], "1", "a read: the SameSite=Strict session is its guard");
});

test("under uhttpd, a rebound name is refused, and the saved file's version comes in the query", (t) => {
  t.deepEqual(request({ HTTP_HOST: "evil.example", PATH_INFO: "/" }), { refused: 403, error: "Forbidden." });
  const version = "a".repeat(64);
  const put = request({ REQUEST_METHOD: "PUT", HTTP_HOST: "gateway", HTTP_ORIGIN: "http://gateway", QUERY_STRING: `version=${version}` });
  t.is((put as { headers: Record<string, string> }).headers["x-onc-version"], version);
  const odd = request({ REQUEST_METHOD: "PUT", HTTP_HOST: "gateway", QUERY_STRING: "version=../x" });
  t.false("x-onc-version" in (odd as { headers: Record<string, string> }).headers);
  t.deepEqual(request({ HTTP_HOST: "gateway", CONTENT_LENGTH: String(3 * 1024 * 1024) }), { refused: 413, error: "Too large." });
});

test("a CGI answer's status carries its reason: uhttpd ignores a bare code and sends 200", (t) => {
  t.regex(cgiResponse({ status: 401, headers: {}, body: "" }), /^Status: 401 Unauthorized\r\n/);
  t.regex(cgiResponse({ status: 418, headers: {}, body: "" }), /^Status: 418 \S/);
});
