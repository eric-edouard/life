import { LIFE_ASKER } from "../core/names";
import {
  type NamingQueueItem,
  namingQueueGuessesOf,
} from "../sources/voice-speakers";
import type { Quote } from "./check-quotes";
import type { Deletions } from "./deletions";
import { plain } from "./doubts";
import { type Check, LIFE_CHECKS, preTickedOf } from "./life-checks";
import { deletionsNow } from "./memory-files";
import type { GuessedQueueItem } from "./voice-guesses";
import {
  type People,
  voiceCardRefOf,
  voicePersonOf,
  voiceSuggestionOf,
} from "./who";
import { localDate } from "./zones";

// The voice checks: each voice the voice server asks him to name, as one of the checks (`checksOf`).

/**
 * A queue item's clips and evidence as a card shows them: one of a recording holding words he deleted goes. A turn's key
 * is `<job>:<turn>` (`deletions.ts`) and evidence names no turn, so its whole recording answers for it.
 */
export const shownClipsOf = (
  item: Pick<NamingQueueItem, "clips" | "evidence" | "voices">,
  d: Deletions = deletionsNow()
) => {
  const touched = (jobId: string) =>
    [...d.refs, ...d.cuts.keys()].some((ref) => ref.startsWith(`${jobId}:`));
  const jobs = new Map(item.voices.map((v) => [v.conversationId, v.jobId]));
  // A clip of no audio names no recording of its own: any recording of the item gone answers for it, as evidence's does.
  const gone = item.voices.some((v) => touched(v.jobId));
  return {
    clips: item.clips.filter((c) =>
      c.audio ? !touched(c.audio.jobId) : !gone
    ),
    evidence: item.evidence.filter(
      (e) => !touched(jobs.get(e.conversationId) ?? "")
    ),
  };
};

/** Every voice the voice server asks him to name, none left out but those he called several people (not asked in v1: one answer would give them all to one). */
export const voiceChecksOf = (
  people: Pick<People, "nameOf" | "names" | "partyOf" | "refOf" | "resolve">,
  voices: readonly GuessedQueueItem[]
) =>
  voices
    .filter((item) => item.kind !== "several")
    .map((item) => {
      const { clips, evidence } = shownClipsOf(item);
      const known = voiceSuggestionOf(people, item);
      const likely = namingQueueGuessesOf(item)
        .flatMap((id) => {
          const ref = voicePersonOf(people.resolve, id, item.names?.[id]);
          return ref ? [ref] : [];
        })
        .filter((ref, i, all) => all.indexOf(ref) === i)
        .slice(0, 5)
        .map(people.partyOf);
      const [first] = evidence;
      const who = known ? people.nameOf(known) : null;
      const check: Omit<Check, "confirm" | "lifeLinks" | "matter"> = {
        about: item.name ? [item.name] : [],
        asker: LIFE_ASKER,
        at: null,
        clips,
        context: `${LIFE_CHECKS.voice.context} Heard in ${item.conversations} conversations, ${item.words} words.`,
        conversations: item.conversations,
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
        // The people it could be are `likelyPeople`, the voice server's suggestion first; "Yes" only when that suggestion is in use.
        options: LIFE_CHECKS.voice.options.filter(
          (o) => who || o.id !== "is-them"
        ),
        // "Yes" is pre-ticked only on the person the voice server's likeness scored (`personId`), never on a name heard beside it.
        preTicked: preTickedOf(
          {
            kind: "voice",
            subject:
              known &&
              known ===
                voicePersonOf(
                  people.resolve,
                  item.personId,
                  item.names?.[item.personId ?? ""]
                )
                ? known
                : null,
          },
          item
        ),
        question: who ? `Is this ${who}?` : "Who is this?",
        ref: voiceCardRefOf(people, item),
        ridesOn: { matterIds: [], matters: 0, observations: 0, pages: 0 },
        said: null,
        since: null,
        // The person the voice server suggests, what makes it a guess in use; null: none (`urgencyOf`).
        subject: who ? known : null,
        title: LIFE_CHECKS.voice.title,
        voiceGuesses: (item.guessed ?? []).flatMap((r) =>
          people.names.has(people.refOf(r))
            ? [
                {
                  person: people.partyOf(people.refOf(r)),
                  why: item.whys?.[r] ?? null,
                },
              ]
            : []
        ),
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
