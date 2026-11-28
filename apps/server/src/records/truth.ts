import { z } from "zod";
import { SourceName } from "../core/names";
import { Birthday, isoDate, slug } from "./fields";

// Truth (truth/): owner-approved, in git, the only data that must survive a rebuild.

export const Handles = z
  .object({
    email: z.array(z.email()).default([]),
    /** Their GitHub login. */
    github: z
      .string()
      .regex(/^[A-Za-z\d-]{1,39}$/)
      .optional(),
    phone: z.array(z.string().regex(/^\+\d{6,15}$/)).default([]),
    telegram: z.string().optional(),
    /** Their person id on the voice server. */
    voice: z.uuid().optional(),
    // Phone numbers in E.164.
    whatsapp: z.array(z.string().regex(/^\+\d{6,15}$/)).default([]),
  })
  .strict();

/** His picture pick: whose picture shows for a person or an organization, Contacts' or a source's; `none`: no picture. Absent: the first they show. */
export const PictureFrom = z.enum(["contacts", ...SourceName.options, "none"]);

export const Person = z
  .object({
    aliases: z.array(z.string()).default([]),
    birthday: Birthday.optional(),
    // The owner's only (read by `readOwnerName`): what Life calls them in prompts and what it writes, when not their name's first word.
    called: z.string().trim().min(1).optional(),
    handles: Handles.default({ email: [], phone: [], whatsapp: [] }),
    id: slug,
    language: z.enum(["en", "fr", "th"]).optional(),
    name: z.string().min(1),
    pictureFrom: PictureFrom.optional(),
    projects: z.array(slug).default([]),
    relation: z.string().optional(),
  })
  .strict();

export type Person = z.infer<typeof Person>;

export const PeopleFile = z
  .object({ people: z.array(Person), schemaVersion: z.literal(1) })
  .strict();

/** His word on who is at an organization: a person's id, their role, and `until` (a year or a day) once they left; none: now. */
export const OrganizationPerson = z
  .object({
    id: slug,
    role: z.string().min(1),
    until: z.union([z.int().min(1000).max(9999), isoDate]).optional(),
  })
  .strict();

/**
 * An organization (truth/organizations.yaml): a named body that is not one human (a company, a firm, a shop, a school, a
 * team's shared account) that he deals with. Its ref is `person:<id>`, in the people's one id space; `isOrganization`
 * on `readPeople` tells them apart. An address in its `handles.email` is the organization; another at one of its
 * `domains` stays a person.
 */
export const Organization = z
  .object({
    aliases: z.array(z.string()).default([]),
    domains: z
      .array(z.string().regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/))
      .default([]),
    handles: Handles.default({ email: [], phone: [], whatsapp: [] }),
    id: slug,
    name: z.string().min(1),
    people: z.array(OrganizationPerson).default([]),
    pictureFrom: PictureFrom.optional(),
    projects: z.array(slug).default([]),
    relation: z.string().optional(),
  })
  .strict();

export type Organization = z.infer<typeof Organization>;

export const OrganizationsFile = z
  .object({ organizations: z.array(Organization), schemaVersion: z.literal(1) })
  .strict();

/** A directory party: someone in his directory, a person or an organization, as the name and handle readers see either. */
export type DirectoryParty = Pick<
  Person,
  | "aliases"
  | "birthday"
  | "handles"
  | "id"
  | "name"
  | "pictureFrom"
  | "projects"
  | "relation"
>;

/** The owner's id in truth/people.yaml. */
export const ME = "me";
/** The owner's own entry in truth/people.yaml. */
export function ownerIn(people: Person[]): Person {
  const me = people.find((p) => p.id === ME);
  if (!me) {
    throw new Error(`truth/people.yaml has no "${ME}"`);
  }
  return me;
}
/** A name's first word ("Jean" for "Jean Dupont"). */
export const firstNameOf = (name: string) => name.trim().split(" ")[0] ?? "";

export const Chat = z
  .object({
    // The chat's key: a network room id (`!…`) or, for a WhatsApp chat with no room, its id in Life's archive (`<id>@g.us`, `<phone>@s.whatsapp.net` or `<id>@lid`). Which projects a chat belongs to is in `Project.chats`.
    id: z.string().regex(/^!|@(g\.us|s\.whatsapp\.net|lid)$/),
    name: z.string(),
    // The WhatsApp id (in Life's archive) of a chat that also has a room id (`<phone>@s.whatsapp.net`, `<id>@g.us` or `<id>@lid`).
    whatsapp: z.string().optional(),
  })
  .strict();

export type Chat = z.infer<typeof Chat>;

export const ChatsFile = z
  .object({ chats: z.array(Chat), schemaVersion: z.literal(1) })
  .strict();

/** The owner's life areas (truth/areas.yaml): the one area vocabulary memory files things under. */
export const Area = z
  .object({
    id: slug,
    name: z.string().min(1),
  })
  .strict();

export type Area = z.infer<typeof Area>;

export const AreasFile = z
  .object({ areas: z.array(Area), schemaVersion: z.literal(1) })
  .strict();

export const Project = z
  .object({
    // An id from truth/areas.yaml.
    area: slug,
    chats: z.array(z.string()).default([]),
    deadlines: z
      .array(z.object({ date: isoDate, what: z.string() }).strict())
      .default([]),
    id: slug,
    name: z.string(),
    people: z.array(slug).default([]),
    // Code repos: a folder name under ~/Work (its main worktree), or owner/name for one that is only on GitHub. The first is the project's main entry point.
    repos: z.array(z.string().min(1)).default([]),
    schemaVersion: z.literal(1),
    status: z.enum(["active", "waiting", "parked", "done"]),
  })
  .strict();

export type Project = z.infer<typeof Project>;

/** A project he is still on (active, or waiting on someone); a parked or done one is not. */
export const isUnderway = (p: Project) =>
  p.status === "active" || p.status === "waiting";
