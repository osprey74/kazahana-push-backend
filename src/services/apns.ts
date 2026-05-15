import http2 from "node:http2";
import { db } from "../db/client";

const REQUEST_TIMEOUT_MS = 10_000;
const JWT_TTL_SEC = 30 * 60;

let apnsHost: string | null = null;
let bundleId: string | null = null;
let teamId: string | null = null;
let keyId: string | null = null;
let signingKey: CryptoKey | null = null;
let cachedJwt: { token: string; expiresAt: number } | null = null;

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const buf = Buffer.from(b64, "base64");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function base64url(input: ArrayBuffer | Uint8Array | string): string {
  if (typeof input === "string") {
    return Buffer.from(input, "utf8").toString("base64url");
  }
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  return Buffer.from(buf).toString("base64url");
}

async function getSigningKey(): Promise<CryptoKey> {
  if (signingKey) return signingKey;
  const der = pemToDer(process.env.APNS_KEY!);
  signingKey = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  return signingKey;
}

async function getJwt(): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwt.expiresAt > nowSec + 60) return cachedJwt.token;

  const key = await getSigningKey();
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iss: teamId, iat: nowSec }));
  const message = `${header}.${payload}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(message)
  );
  const token = `${message}.${base64url(sig)}`;
  cachedJwt = { token, expiresAt: nowSec + JWT_TTL_SEC };
  return token;
}

export function initApns() {
  const key = process.env.APNS_KEY;
  const kid = process.env.APNS_KEY_ID;
  const tid = process.env.APNS_TEAM_ID;
  if (!key || !kid || !tid) {
    console.warn("APNs not configured — iOS push disabled");
    return;
  }
  keyId = kid;
  teamId = tid;
  bundleId = process.env.APNS_BUNDLE_ID || "com.osprey74.kazahana";
  apnsHost = process.env.APNS_PRODUCTION === "true"
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";
  console.log(`APNs (node:http2) initialized — host=${apnsHost} bundle=${bundleId}`);
}

export async function sendApns(
  token: string,
  title: string,
  body: string,
  targetDid: string
): Promise<void> {
  if (!apnsHost) return;

  let jwt: string;
  try {
    jwt = await getJwt();
  } catch (e) {
    console.log(`APNs JWT error: ${e}`);
    return;
  }

  const payload = JSON.stringify({
    aps: { alert: { title, body }, sound: "default" },
    target_did: targetDid,
  });

  const shortToken = token.slice(0, 8);
  const shortDid = targetDid.slice(0, 24);

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const client = http2.connect(apnsHost!);

    const timer = setTimeout(() => {
      if (settled) return;
      console.log(`APNs TIMEOUT ${shortToken} did=${shortDid}`);
      try { client.destroy(); } catch { /* ignore */ }
      finish();
    }, REQUEST_TIMEOUT_MS);

    client.on("error", (err) => {
      if (settled) return;
      console.log(`APNs CONN ERROR ${shortToken} did=${shortDid} ${err.message}`);
      clearTimeout(timer);
      try { client.destroy(); } catch { /* ignore */ }
      finish();
    });

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": bundleId!,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    });

    let status = 0;
    const chunks: Buffer[] = [];

    req.on("response", (headers) => {
      status = Number(headers[":status"]);
    });

    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      clearTimeout(timer);
      if (settled) return;

      if (status >= 200 && status < 300) {
        try { client.close(); } catch { /* ignore */ }
        finish();
        return;
      }

      let reason: string | undefined;
      try {
        const responseBody = Buffer.concat(chunks).toString("utf8");
        if (responseBody) reason = JSON.parse(responseBody).reason;
      } catch { /* body may be empty or non-JSON */ }

      console.log(
        `APNs FAIL ${shortToken} did=${shortDid} status=${status} reason=${reason ?? "-"}`
      );

      if (status === 410 || reason === "Unregistered" || reason === "BadDeviceToken") {
        console.log(`APNs: removing invalid token ${shortToken}...`);
        db.run(`DELETE FROM device_tokens WHERE token = ?`, [token]);
      }

      try { client.close(); } catch { /* ignore */ }
      finish();
    });

    req.on("error", (err) => {
      if (settled) return;
      console.log(`APNs REQ ERROR ${shortToken} did=${shortDid} ${err.message}`);
      clearTimeout(timer);
      try { client.destroy(); } catch { /* ignore */ }
      finish();
    });

    req.end(payload);
  });
}
