import { type ProfilesByModel, speakerVoice } from "./people";
import { NO_PROFILES, profilesWithout, soundsLikeOf } from "./speakers";

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
