// Life's pick of a matter's icon, graded on made-up matters (English, French, some too vague for any icon): each case
// lists the keys that are right, none for a vague one. `LIFE_OWNER_DATA_DIR=<a copy> bun scripts/matter-icon-cases.ts`
// asks the model (`pickMatterIcons`, which appends to the copy's memory) and prints right, wrong (a wrong icon is worse
// than none) and none.
import {
  iconNow,
  pickMatterIcons,
  readLifeIcons,
} from "../apps/server/src/memory/matter-icons";
import type { MatterView } from "../apps/server/src/memory/matter-read";
import type { MatterIconKey } from "../apps/server/src/records/matter-icon";

type Case = [name: string, goal: string | undefined, right: MatterIconKey[]];

export const CASES: Case[] = [
  [
    "Get the deposit back from the old flat",
    "The landlord returns the deposit",
    ["key", "money"],
  ],
  ["Fix the leaking kitchen tap", undefined, ["water", "tools"]],
  ["Renew passport before the trip", "A new passport in hand", ["id"]],
  ["Book the dentist check-up", undefined, ["health", "doctor"]],
  ["Buy a birthday present for the niece", undefined, ["gift", "cake"]],
  [
    "Return the shoes that don't fit",
    "The refund for the shoes arrives",
    ["clothes", "box"],
  ],
  ["Dispute the double charge on the card", undefined, ["card"]],
  ["File the yearly tax return", "Taxes filed on time", ["bank", "paper"]],
  [
    "Plan the summer trip to Portugal",
    "Flights and hotel booked",
    ["suitcase", "plane"],
  ],
  ["Find a new phone plan", undefined, ["phone", "iphone"]],
  ["Take the cat to the vet", undefined, ["pet"]],
  ["Hire a painter for the living room", undefined, ["paint"]],
  [
    "Answer the client's proposal by Friday",
    "The proposal answered",
    ["work", "mail", "talk", "paper"],
  ],
  ["Car service and new tyres", undefined, ["car"]],
  ["Fix the broadband dropping every evening", undefined, ["wifi"]],
  [
    "Récupérer la caution de l'appartement",
    "Le propriétaire rend la caution",
    ["key", "money"],
  ],
  ["Prendre rendez-vous chez le dermatologue", undefined, ["health", "doctor"]],
  ["Renouveler la carte de séjour", "Nouvelle carte de séjour reçue", ["id"]],
  ["Acheter un canapé pour le salon", undefined, ["sofa"]],
  [
    "Organiser l'anniversaire de maman",
    "Une fête surprise pour ses 60 ans",
    ["cake", "party", "family"],
  ],
  ["Résilier l'abonnement à la salle de sport", undefined, ["card", "gym"]],
  ["Réparer le vélo", undefined, ["bike"]],
  ["Réserver une table pour samedi soir", undefined, ["food"]],
  ["Envoyer le colis à ma sœur", "Le colis arrive chez elle", ["box"]],
  ["Signer le contrat de travail", undefined, ["sign", "work"]],
  ["Follow up", undefined, []],
  ["The thing with the neighbour", undefined, []],
  ["Sort it out", undefined, []],
  ["Le truc de mardi", undefined, []],
  ["Check on that", "Done", []],
];

/** Right, wrong and none over the cases, given each case's pick (null for none). Pure. */
export function gradeOf(picks: readonly (MatterIconKey | null | undefined)[]) {
  const tally = { none: 0, right: 0, vagueRight: 0, wrong: 0 };
  for (const [i, [, , right]] of CASES.entries()) {
    const pick = picks[i] ?? null;
    if (pick === null) {
      tally[right.length === 0 ? "vagueRight" : "none"] += 1;
    } else {
      tally[right.includes(pick) ? "right" : "wrong"] += 1;
    }
  }
  return tally;
}

if (import.meta.main) {
  const views = CASES.map(
    ([name, goal], i) =>
      ({
        goal: goal && { at: "", by: "life", text: goal },
        id: `matter_case${i}`,
        name,
      }) as MatterView
  );
  console.log(await pickMatterIcons(views));
  const picks = readLifeIcons();
  const chosen = views.map((v) => iconNow(v, picks)?.key ?? null);
  console.log(JSON.stringify(chosen));
  console.log(gradeOf(chosen));
}
