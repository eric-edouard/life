import type { Contact } from "../sources/contacts";
import { detailRefOf, readCardsOf } from "./details";
import type { People } from "./who";

// The likely links of someone in his directory to an organization of his directory that his directory does not hold
// (life#874): their Contacts card names its company, with a job title, the role his Yes writes. Asked as one card ("Is X
// at <organization> as <role>?"), never decided by Life; worked out when the inbox is read and again at his answer,
// never stored.

const REF = /^at:(person:[^~]+)~(person:[^~]+)$/;
/** A card's ref, bound to both, so a tap answers only the pair he saw. */
export const atOrganizationRefOf = (organization: string, person: string) =>
  `at:${organization}~${person}`;
/** The organization and the person a card's ref names; none for another ref. */
export const atOrganizationPairOf = (ref: string) => {
  const [, organization = "", person = ""] = ref.match(REF) ?? [];
  return { organization, person };
};

export interface AtOrganization {
  /** Why Life asks: the Contacts card's work line, as written. */
  evidence: string;
  organization: string;
  person: string;
  /** Their role as their Contacts card gives it: its job title and department. */
  role: string;
}

/** A Contacts card's work line less its company ("Designer, Acme" → "Designer"); null when it holds only the company. */
const roleOf = ({ company, work }: Contact) =>
  company && work?.endsWith(`, ${company}`)
    ? work.slice(0, -(company.length + 2))
    : null;

/**
 * Each person of his directory and organization of his directory not linked in it (current or past) where one of their
 * Contacts cards (`cardsOf`) names it as its company (`detailRefOf`, the one rule) with a role. A pair his No refused
 * (`not-at-organization`) is never asked again. ponytail: no role, no card (`OrganizationPerson.role` is required, the
 * phone's too); an address at one of its `domains` asks nothing until a link may lack a role.
 */
export function atOrganizationPairsOf(
  people: Pick<
    People,
    "canon" | "corrections" | "isOrganization" | "resolve" | "truth"
  >,
  cardsOf: (ref: string) => Contact[]
): AtOrganization[] {
  const { canon, truth } = people;
  const companyOf = detailRefOf(people);
  const asked = new Set([
    ...people.corrections.flatMap((c) =>
      c.kind === "not-at-organization"
        ? [`${canon(c.organization)}|${canon(c.person)}`]
        : []
    ),
    ...truth.organizations.flatMap((o) =>
      o.people.map((m) => `person:${o.id}|person:${m.id}`)
    ),
  ]);
  const pairs = new Map<string, AtOrganization>();
  for (const { id } of truth.people) {
    const person = `person:${id}`;
    for (const card of cardsOf(person)) {
      const organization = card.company && companyOf("work", card.company);
      const role = roleOf(card);
      const key = `${organization}|${person}`;
      if (organization && role && !asked.has(key) && !pairs.has(key)) {
        pairs.set(key, {
          evidence: `Their Contacts card says “${card.work}”.`,
          organization,
          person,
          role,
        });
      }
    }
  }
  return [...pairs.values()];
}

/** The pairs as his directory and his Contacts hold them now: what the inbox shows and what his answer is checked against. */
export const readAtOrganizationPairs = (
  people: Parameters<typeof atOrganizationPairsOf>[0] &
    Pick<People, "ownerOfCard">
) => atOrganizationPairsOf(people, readCardsOf(people));

/** Each pair as its card asks it: the question with the role his Yes writes, the evidence as its context, the organization as who it may be. */
export const atOrganizationAsksOf = (
  people: Pick<People, "nameOf" | "partyOf">,
  pairs: readonly AtOrganization[]
) =>
  pairs.map((p) => ({
    about: [],
    context: p.evidence,
    likelyPeople: [people.partyOf(p.organization)],
    /** The kept lines about the person: the card is asked only while they matter. */
    linesOf: <L>(byRef: ReadonlyMap<string, L[]>) => byRef.get(p.person) ?? [],
    question: `Is ${people.nameOf(p.person)} at ${people.nameOf(p.organization)} as ${p.role}?`,
    ref: atOrganizationRefOf(p.organization, p.person),
    refs: [p.person],
  }));
