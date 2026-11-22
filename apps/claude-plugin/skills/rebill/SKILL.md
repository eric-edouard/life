---
name: rebill
description: Move the services failing on an old or expired payment method to the owner's new card. Use when payment-failed mails or matters point to one dead card, or when he says "rebill", "my card expired" or "update my card everywhere".
---

# rebill

Find the services cut off by one dead payment method, check each, and ask for his hand only where the old method is
still on file. You never type a card number, a password or a code, and you never pay: he adds the card.

1. **Find the failures.** Search his mail (every account he has) and `read_matters` for
   failed payments, "card declined", "payment method expired", "update billing" (last 90 days). Per service note: name,
   billing-page link (from the mail, never guessed), the old method as the mail names it (brand, last 4, expiry), the
   failed amount. One row per service. A service with a newer paid receipt is already fixed: drop it.
2. **Check each service in his Chrome** (his logged-in browser session; sign in through his password manager if a page asks, his hand only for a CAPTCHA, passkey or code). Read the payment method the billing page shows now:
   - a different, valid method (not the old last 4, not expired): **done**. No card for it.
   - the old method, or none: **needs him**.
   - a way you cannot do from here: a QR or PromptPay payment, a bank-account link, a direct debit or mandate, a
     passkey or CAPTCHA login: **can't do here**.
3. **One grouped card** (`request_decision`, `fetch("ask/link")`, `fetch("ask/text")`) when any service needs him, titled "Add your new
   card on these N services". `context`: per service, what failed and since when, the old method, and what you saw on
   the page. `needs`: one `link` per service (`url` its billing page, `vendor` its name; at most 8 per card, a second
   card for more), then a `text` need per "can't do here" service saying what it is and where to do it (the page or
   app, never a guessed link). Options: "Done, I added it" and "Drop it" (`icon: "drop"`); `doneSeenBy: "tap"`;
   `ends: "matter"` on Drop only when nothing else is left. A sign-in that is his hand rides on the same card: the
   link, and "sign in first".
4. **After his Done, re-verify every listed service** as in step 2. Close each fixed service's matter you hold (`finish`). Any still showing
   the old method: one short follow-up card for those only, once; then drop it. Never ask twice for a service already fixed.

Rules: the web and his Mac are free, the card is the gate. Never fill a payment form, retry a charge or accept a new
terms page for him. Say in the card what you could not read rather than guessing. Never put card digits beyond the
last 4 in a card or a note.
