// An integration is anything a user turns on that needs something from them to work: a source, a messaging network,
// Google, the AI, the voice engine, the pendant, the way the phone reaches the host. It is not the connector (Life's MCP
// server, which keeps that name), an output (`core/outputs.ts`) or an add-on (`core/add-ons.ts`), which are settings with
// no step for the user (`docs/plans/2026-11-28-packaging/spec.md`, section 1).

/** What Life checks silently for an access card's step: a permission of Life's, Full Disk Access, or free disk space. A permission requirement is Full Disk Access alone. */
export const ACCESS_CHECKS = [
  "accessibility",
  "calendars",
  "contacts",
  "disk_free",
  "full_disk_access",
  "photos",
] as const;
export type AccessCheck = (typeof ACCESS_CHECKS)[number];

/** What an integration takes, in the order the user meets it; whether each is done is worked out when read, never stored. Not a card's need (`memory/needs.ts`). */
export type Requirement =
  | { kind: "permission"; check: "full_disk_access" }
  | { kind: "sign_in"; with: "network" | "claude" }
  | { kind: "key"; name: string; opens: string; optional?: true }
  | { kind: "credits"; with: "openrouter" }
  | { kind: "install"; what: "claude_code" }
  | { kind: "device"; what: "pendant" | "phone" };

/** An integration's static terms, on its registry entry (a source's `Descriptor`, a `NETWORKS` entry, a `PROVIDERS` entry): what it is good for, what leaves the computer, and what it takes that no other field of the entry already says. */
export interface IntegrationTerms {
  privacy: string;
  requirements: readonly Requirement[];
  value: { answer: string; ask: string };
}
