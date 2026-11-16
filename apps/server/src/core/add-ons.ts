import { settings } from "./settings";

// The personal add-ons (docs/glossary.md, "add-on"): memory layers about him and the people close to him, each off
// while its key is absent from `settings().personal`. Not an output: an output writes outside Life, an add-on only
// adds to what Life keeps. Each module does its own work and reads the rest of its settings; nothing else reads `personal`.
export const ADD_ONS = {
  /** The Views and Health sections of pages. */
  aboutMe: {
    describe: "What he thinks, values and how he is, kept on his page.",
    label: "About me",
  },
  /** The histories (`memory/histories.ts`). */
  histories: {
    describe: "Each past month with someone, and the story of the years.",
    label: "Histories",
  },
  /** The personas (`memory/personas.ts`). */
  personas: {
    describe: "What each person is like and what repeats between them and him.",
    label: "Personas",
  },
  /** The connection and conflict reads of an exchange (`memory/exchange-reads.ts`). */
  relationshipReads: {
    describe: "How each exchange with someone went: connection and conflict.",
    label: "Relationship reads",
  },
  /** The Between us section of pages. */
  relationships: {
    describe: "How things stand between him and the people close to him.",
    label: "Relationships",
  },
} satisfies Record<string, { describe: string; label: string }>;

type AddOn = keyof typeof ADD_ONS;

export const hasAddOn = (addOn: AddOn) => Boolean(settings().personal?.[addOn]);
