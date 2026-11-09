---
type: grilling
blocked_by: []
---

# Naming the unnamed voices

## Question

Nearly half of the recorded turns by others carry no name. Measured 9 Nov (aggregates, Life's store joined to lifelog's
archive): of 35,037 unnamed turns by others, 27,795 (about 1.2M characters) fall in conversations where one of the 16
people he is recorded with most also speaks, against 2.9M characters of named turns by those people; 7,071 of them are
full sentences (40+ characters). Many may be those people split into a second voice, or the people around them.
lifelog keeps the audio and transcripts forever but deletes unnamed voice embeddings after 30 days, so old ones can be
re-embedded from audio but not re-matched as they are.

How do these turns get named before the pilot reads them: re-embedding from audio and re-matching against today's
profiles, joining split voices within a conversation, context (who else spoke, where), or asking him in conversation
for the few clusters that decide the most words. What stays unnamed, and how it is shown. The fix lands in lifelog,
and the data is fixed before the whole history is read once.

## Answer

Decided with him, 9 Nov, one question at a time. Why voices slip past his naming today (lifelog's `NAMING` and
`RECOGNITION`): a card needs 10 turns traded with him and 60 s of talk; cards cover 30 days only; unnamed voice
fingerprints are deleted after 30 days; one person is often split into a second, unnamed voice. The fix, all in lifelog:

1. Old unnamed voices are fingerprinted again from the audio (kept forever) and matched against today's profiles, at
   lifelog's own bar.
2. Within one conversation, an unnamed voice that clearly matches a person named in the same recording joins them.
3. Unnamed fingerprints are kept until the voice is named or he marks it "not anyone I know"; the 30-day deletion goes.
   Naming a voice then names it in every past recording.
4. "Who's this?" also asks about voices that say a lot in his recordings without talking to him, ranked by the words a
   name would unlock; strangers heard once with little said still get none. Same morning notification, never a queue.

Whatever stays unnamed is context only (ticket Who really spoke in a recording). Done before the pilot reads the
history: the share of unnamed turns near his regular people is measured again after 1–2, and the pilot uses that data.
No model spend.

Added the same day (his yes): in a one-to-one phone call, a voice lifelog heard over the phone is the person called.
This lives in Life, not lifelog (lifelog never sees the call): Life joins the call line (`phoneCall`) with how voices
were heard (`heardAs`) when it reads who spoke, and the evidence basis is the call, not a voice match. It reverses
AGENTS.md's "who he talked with on it is the model's reading … never a timing rule" for this one case; the build PR
rewrites that line. Group calls and calls where his own room also speaks stay with the model's reading.
