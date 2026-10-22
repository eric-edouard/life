import { z } from "zod";

// The field shapes the records share: slugs, dates, ids, salience.

export const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase-slug");
export const isoDate = z.iso.date();
export const isoDateTime = z.iso.datetime({ offset: true });
export const Salience = z.int().min(0).max(3);
export const UnitId = z.string().regex(/^u_[0-9a-f]{12}$/);
/** 16 hex of SHA-256 over a unit's content. */
export const ContentHash = z.string().regex(/^[0-9a-f]{16}$/);
/** person:<slug>, project:<slug> or area:<slug> (design §3.2). */
export const EntityRef = z.string().regex(/^(person|project|area):[a-z0-9-]+$/);
export const MomentId = z.string().regex(/^mom_[0-9a-f]{12}$/);
export const PersonRef = z.string().regex(/^person:[a-z0-9-]+$/);
