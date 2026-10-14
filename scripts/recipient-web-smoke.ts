// Run only against scripts/recipient-web-local.ts. Captured test links stay in memory.
const origin = "http://localhost:8890";
let cookie = "";
const requests: string[] = [];
async function request(path: string, body?: unknown) {
  requests.push(path);
  return fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    redirect: "manual",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const harness = await (await request("/__local")).text();
const token = harness.match(/href="[^"#]+\/receive#([^"]+)"/)?.[1];
check(token, "Local fixture unavailable");
const shell = await request("/receive");
check(shell.headers.get("Referrer-Policy") === "no-referrer", "Referrer policy missing");
const html = await shell.text();
check(
  !html.includes(token) && !html.includes("家族への機密メッセージ"),
  "Private content in static shell",
);
check(
  (await request("/v1/received", { token, action: "preview" })).status === 401,
  "Authentication was bypassed",
);
check(
  (
    await request("/api/auth/sign-in/magic-link", {
      email: "family@example.jp",
      callbackURL: `${origin}/recipient-auth`,
    })
  ).ok,
  "Local auth request failed",
);
const mailbox = await (await request("/__local/mail")).text();
const authLink = mailbox.match(/href="([^"]+)"/)?.[1];
check(authLink && new URL(authLink).origin === origin, "Local auth link unavailable");
const auth = await fetch(authLink, { redirect: "manual" });
check(
  auth.status === 302 && auth.headers.get("location") === `${origin}/recipient-auth`,
  "Auth callback failed",
);
cookie = auth.headers.get("set-cookie")?.match(/better-auth\.session_token=[^;]+/)?.[0] ?? "";
check(cookie, "Session cookie missing");
const preview = await request("/v1/received", { token, action: "preview" });
const data = (await preview.json()) as { noticeVersion: string; message?: unknown };
check(preview.ok && data.noticeVersion && !data.message, "Unsafe preview");
check(
  (
    await request("/v1/received", {
      token,
      action: "read",
      deathConfirmed: true,
      noticeVersion: "old",
    })
  ).status === 422,
  "Old notice accepted",
);
const read = { token, action: "read", deathConfirmed: true, noticeVersion: data.noticeVersion };
const opened = await request("/v1/received", read);
check(
  opened.ok && (await opened.text()).includes("家族への機密メッセージ"),
  "Explicit opening failed",
);
check((await request("/__local/pause", {})).ok, "Local stop failed");
const stopped = await request("/v1/received", read);
check(
  stopped.status === 404 && !(await stopped.text()).includes("家族への機密メッセージ"),
  "Stopped message disclosed",
);
check(
  requests.every((path) => !path.includes(token)),
  "Delivery token entered request URL",
);
console.log(
  "Recipient HTTP flow passed: static shell, email authentication, preview, old-version rejection, explicit opening, stop/revocation, URL and headers.",
);

export {};
