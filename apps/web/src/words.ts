// The app's words in his language (a decision's `lang`; English when none says).
export type Lang = "en" | "fr" | undefined;

export const say = (lang: Lang, fr: string, en: string) =>
  lang === "fr" ? fr : en;

const FIRST_LETTER = /^./;
/** A loop's id as he reads it: "lynx-store" is "Lynx store". */
export const loopName = (loop: string) =>
  loop.replaceAll("-", " ").replace(FIRST_LETTER, (c) => c.toUpperCase());
