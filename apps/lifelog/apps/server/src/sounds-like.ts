// Who a speaker sounds like, against the people's profiles: the names a card offers, closest
// first, and whether a name he gave is a recheck.
import { type ProfilesByModel, speakerVoice } from "./people";
import {
  NO_PROFILES,
  profilesWithout,
  rankPeople,
  soundsLikeOf,
} from "./speakers";

// Whether a speaker he named is a recheck, from its own samples: one model's, against that
// model's profiles without `conversations`. The queue and the voice eval read this.
export function recheckOf(
  samples: Parameters<typeof speakerVoice>[0],
  namedPersonId: string,
  profiles: ProfilesByModel,
  conversations: Set<string>
) {
  const voice = speakerVoice(samples);
  return soundsLikeOf(
    voice.samples.map((s) => s.embedding),
    namedPersonId,
    profilesWithout(profiles.get(voice.model) ?? NO_PROFILES, conversations)
      .people
  );
}

// Everyone, the most like the speaker first; none when it is too short to judge.
export function likelyOf(
  samples: Parameters<typeof speakerVoice>[0],
  profiles: ProfilesByModel
) {
  const voice = speakerVoice(samples);
  return voice.vector
    ? rankPeople(
        voice.vector,
        (profiles.get(voice.model) ?? NO_PROFILES).people
      ).map((p) => p.personId)
    : [];
}
