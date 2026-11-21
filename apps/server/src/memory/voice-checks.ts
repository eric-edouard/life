import { LIFE_ASKER } from "../core/names";
import { namingQueueGuessesOf } from "../sources/lifelog-voices";
import type { Quote } from "./check-quotes";
import { plain } from "./doubts";
import { type Check, LIFE_CHECKS, preTickedOf } from "./life-checks";
import type { GuessedQueueItem } from "./voice-guesses";
import {
  isSuggestionBackedOf,
  type People,
  voiceCardRefOf,
  voicePersonOf,
  voiceSuggestionOf,
} from "./who";
import { localDate } from "./zones";

// The voice checks: each voice lifelog asks him to name, as one of the checks (`checksOf`).

/** Every voice lifelog asks him to name, none left out but those he called several people (not asked in v1: one answer would give them all to one). */
export const voiceChecksOf = (
  people: Pick<People, "nameOf" | "names" | "partyOf" | "refOf" | "resolve">,
  voices: readonly GuessedQueueItem[]
) =>
  voices
    .filter((item) => item.kind !== "several")
    .map((item) => {
      const known = voiceSuggestionOf(people, item);
      const likely = namingQueueGuessesOf(item)
        .flatMap((id) => {
          const ref = voicePersonOf(people.resolve, id, item.names?.[id]);
          return ref ? [ref] : [];
        })
        .filter((ref, i, all) => all.indexOf(ref) === i)
        .slice(0, 5)
        .map(people.partyOf);
      const [first] = item.evidence;
      const who = known ? people.nameOf(known) : null;
      const check: Omit<Check, "confirm" | "lifeLinks" | "matter"> = {
        about: item.name ? [item.name] : [],
        asker: LIFE_ASKER,
        at: null,
        clips: item.clips,
        context: `${LIFE_CHECKS.voice.context} Heard in ${item.conversations} conversations, ${item.words} words.`,
        deadline: null,
        draft: null,
        goal: null,
        group: "voice",
        kind: "voice",
        likelyPeople: likely,
        links: [],
        notSent: null,
        onMatters: [],
        onSilence: null,
        // The people it could be are `likelyPeople`, lifelog's suggestion first; "Yes" only when that suggestion is in use.
        options: LIFE_CHECKS.voice.options.filter(
          (o) => who || o.id !== "is-them"
        ),
        // "Yes" is pre-ticked only on a suggestion lifelog's sound or a sure guess backs, never on a name heard beside it.
        preTicked: preTickedOf(
          {
            kind: "voice",
            subject:
              known && isSuggestionBackedOf(people, item, known) ? known : null,
          },
          item
        ),
        question: who ? `Is this ${who}?` : "Who is this?",
        ref: voiceCardRefOf(people, item),
        ridesOn: { matterIds: [], matters: 0, observations: 0, pages: 0 },
        said: null,
        since: null,
        // The person lifelog suggests, what makes it a guess in use; null: none (`urgencyOf`).
        subject: who ? known : null,
        title: LIFE_CHECKS.voice.title,
      };
      const quote: Quote | undefined = first && {
        text: first.text,
        where: `a recorded conversation, ${first.at ? plain(localDate(first.at)) : "date unknown"}`,
      };
      return {
        check,
        day: item.clips.reduce(
          (m, k) => (k.at && localDate(k.at) > m ? localDate(k.at) : m),
          ""
        ),
        quote,
      };
    });
