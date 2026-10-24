import type { Config } from "./config";

// One email to the owner; the status code, or null when the key or an address isn't configured.
// `key` makes a retry of the same alert one email.
export async function emailOwner(
  config: Config,
  { key, subject, text }: { key: string; subject: string; text: string }
): Promise<number | null> {
  const { ALERT_EMAIL_FROM, ALERT_EMAIL_TO, RESEND_API_KEY } = config;
  if (!(RESEND_API_KEY && ALERT_EMAIL_FROM && ALERT_EMAIL_TO)) {
    return null;
  }
  const { status } = await fetch("https://api.resend.com/emails", {
    body: JSON.stringify({
      from: ALERT_EMAIL_FROM,
      subject,
      text,
      to: [ALERT_EMAIL_TO],
    }),
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    method: "POST",
  });
  return status;
}
