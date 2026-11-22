// A page or a mail's HTML as its text: what Life reads of HTML mail (`sources/mail.ts`) and of a page an agent fetches
// (`desk/runtimes/web-tools.ts`). ponytail: tags and entities only, no Markdown structure.

const ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

/** `html`'s text: styles, scripts and the head dropped, block ends as line breaks, tags removed, entities read. */
export const htmlTextOf = (html: string) =>
  html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(x?)([0-9a-f]+);/gi, (_, x: string, n: string) =>
      String.fromCodePoint(Number.parseInt(n, x ? 16 : 10))
    )
    .replace(
      /&(\w+);/g,
      (m, name: string) => ENTITIES[name.toLowerCase()] ?? m
    );
