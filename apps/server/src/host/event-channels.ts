// What a filter matches: one shape for every event (`Matchable`), so one matcher (`matcherOf`, `events.ts`) decides.

/**
 * An event as a filter sees it: a message, a call or another channel's item, each adapted where it is read. Its rules,
 * written once (`matcherOf`): no `fromMe` counts as not his, so `from_me: false` passes it and `from_me: true` does
 * not; a `chat`, `people` or `text` an event cannot answer matches nothing (a call has no text). The text is only tested: an event never carries it.
 */
export interface Matchable {
  channel: string;
  chat?: string;
  fromMe?: boolean;
  people?: string[];
  text?: string;
}
