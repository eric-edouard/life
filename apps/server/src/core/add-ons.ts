import { type Settings, settings } from "./settings";

// The personal add-ons (docs/glossary.md, "add-on"): memory layers about him and the people close to him, each off
// while its key is absent from `settings().personal`. Not an output: an output writes outside Life, an add-on only
// adds to what Life keeps. Each module does its own work; nothing else reads `personal`.

type AddOn = keyof NonNullable<Settings["personal"]>;

/** An add-on's settings, undefined while it is off. */
export const addOnOf = <A extends AddOn>(addOn: A) =>
  settings().personal?.[addOn];

export const hasAddOn = (addOn: AddOn) => Boolean(addOnOf(addOn));
