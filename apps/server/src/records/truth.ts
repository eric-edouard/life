import { z } from "zod";
import { isoDate, slug } from "./fields";

// Truth (truth/): owner-approved, in git, the only data that must survive a rebuild.

const Handles = z
  .object({
    email: z.array(z.email()).default([]),
    lifelog: z.uuid().optional(),
    phone: z.array(z.string().regex(/^\+\d{6,15}$/)).default([]),
    telegram: z.string().optional(),
    // Phone numbers in E.164.
    whatsapp: z.array(z.string().regex(/^\+\d{6,15}$/)).default([]),
  })
  .strict();

export const Person = z
  .object({
    aliases: z.array(z.string()).default([]),
    // `--MM-DD`, or `YYYY-MM-DD` when the year is known.
    birthday: z
      .string()
      .regex(/^(--|\d{4}-)\d{2}-\d{2}$/)
      .refine((b) => isoDate.safeParse(b.replace("--", "2000-")).success)
      .optional(),
    handles: Handles.default({ email: [], phone: [], whatsapp: [] }),
    id: slug,
    language: z.enum(["en", "fr", "th"]).optional(),
    name: z.string().min(1),
    projects: z.array(slug).default([]),
    relation: z.string().optional(),
  })
  .strict();

export type Person = z.infer<typeof Person>;

export const PeopleFile = z
  .object({ people: z.array(Person), schemaVersion: z.literal(1) })
  .strict();

export const Chat = z
  .object({
    // network chat id. Which projects a chat belongs to is in `Project.chats`.
    id: z.string().startsWith("!"),
    name: z.string(),
    // WhatsApp chats: the chat id in Life's archive (`<phone>@s.whatsapp.net`, `<id>@g.us` or `<id>@lid`).
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
