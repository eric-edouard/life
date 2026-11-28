import { z } from "zod";
import { isoDateTime, MadeBy } from "./fields";

// A matter's icon (docs/glossary.md: matter icon): one key of this fixed set, saying what is being done. Each key's line
// is what Life's pick is shown beside a matter's text (`memory/matter-icons.ts`); the phone maps a key to its symbol
// (`MatterIcons.swift`, checked against this list). A key is stored in his corrections (`matter-icon`) and in Life's
// picks, so removing or renaming one is a rename with its migration (.claude/rules/memory.md, "A rename or a new field backfills"); a
// line may change freely: Life's picks are asked again (their key holds the lines).

/** Each key and the line Life's pick is shown, in the grid's order (an array: the formatter sorts object keys). */
export const MATTER_ICONS = [
  ["home", "a home in general: the house or flat, moving in, household chores"],
  [
    "key",
    "renting or buying a place: a lease, a landlord, keys, a tenancy, a deposit on a flat",
  ],
  [
    "sofa",
    "furniture and furnishing: a sofa, shelves, a table, decorating a room",
  ],
  [
    "bed",
    "sleep and bedrooms: a mattress, bedding, a hotel night, a guest staying over",
  ],
  ["light", "an idea to explore, lighting, a lamp or bulb to replace"],
  [
    "tools",
    "a repair or maintenance job: fixing an appliance, servicing, a technician's visit",
  ],
  [
    "hammer",
    "building work and renovation: a kitchen or bathroom fitted, a contractor, a builder's quote",
  ],
  [
    "paint",
    "painting and decorating: walls to paint, a painter, colours to choose",
  ],
  ["plant", "plants and garden: gardening, a gardener, a balcony, lawn care"],
  ["water", "water and plumbing: a leak, a plumber, the water bill, a boiler"],
  [
    "power",
    "electricity and energy: the power bill, an electrician, an outage, a meter",
  ],
  [
    "box",
    "a delivery or a parcel: an order arriving, a return, tracking, posting something",
  ],
  [
    "cart",
    "groceries and routine shopping: a supermarket order, household supplies",
  ],
  [
    "bag",
    "buying a particular item: a purchase to choose, a product to compare, a shop",
  ],
  ["gift", "a present for someone: choosing, buying or sending a gift"],
  [
    "clothes",
    "clothes: buying or returning clothing, a tailor, laundry, dry cleaning",
  ],
  [
    "money",
    "money owed or to pay in general: a debt, a reimbursement, cash, splitting a bill",
  ],
  [
    "card",
    "a card or an online payment: a bank card to replace, a subscription to pay or cancel, a charge to dispute",
  ],
  [
    "bank",
    "a bank or the state: opening an account, a loan, taxes, a government office",
  ],
  [
    "paper",
    "paperwork: a quote, an invoice, a contract to read, a document to send",
  ],
  [
    "sign",
    "something to sign: a contract, a form, an agreement, an authorisation",
  ],
  [
    "mail",
    "a letter or a formal mail: registered post, an official answer to write",
  ],
  [
    "insurance",
    "insurance and protection: a policy, a claim, a warranty, a guarantee",
  ],
  [
    "chart",
    "investments and business numbers: a portfolio, revenue, growth, a budget to track",
  ],
  [
    "id",
    "identity papers: a passport, a visa, an ID card, a driving licence, a residence permit",
  ],
  [
    "person",
    "one person to deal with: an introduction, a favour for someone, a promise to a friend",
  ],
  [
    "people",
    "a group or a meeting between people: an introduction, a team, hiring, a partner",
  ],
  ["family", "family: parents, children, a relative's needs, a family plan"],
  [
    "heart",
    "a partner or a close relationship: a date, an anniversary, something for someone loved",
  ],
  ["cake", "a birthday or a celebration meal to organise"],
  [
    "party",
    "a party or an event to host: a wedding, a dinner with friends, invitations",
  ],
  [
    "talk",
    "a conversation to have or an answer owed: a discussion, a negotiation, a reply",
  ],
  [
    "phone",
    "a phone call to make or a phone plan: calling an office, a mobile contract",
  ],
  [
    "work",
    "work in general: a client, a job, a professional task with no better icon",
  ],
  [
    "laptop",
    "a computer or a digital setup: a laptop to buy or fix, software to install, an account to set up",
  ],
  [
    "code",
    "software being built: an app, a feature, a bug, a release, a website",
  ],
  [
    "megaphone",
    "marketing and reach: an advertising budget, a campaign, social posts, a launch",
  ],
  [
    "calendar",
    "a date to set: an appointment to book, a schedule, a meeting to plan",
  ],
  [
    "clock",
    "something waiting on time: a deadline, a renewal date, a reminder with no other subject",
  ],
  ["study", "learning: a course, a class, an exam, a school, a certificate"],
  ["book", "reading and writing: a book, an article, notes, a manual"],
  [
    "pencil",
    "something to write or design: a text, a draft, a drawing, a plan to sketch",
  ],
  [
    "health",
    "health in general: a medical appointment, a dentist, a hospital, a test result",
  ],
  ["pills", "medicine: a prescription, a pharmacy, a treatment to follow"],
  ["doctor", "a doctor's visit: a check-up, a specialist, a diagnosis"],
  [
    "run",
    "sport and outdoor activity: running, a race, a sports club, a dive course",
  ],
  ["gym", "the gym and training: a membership, a coach, a workout programme"],
  ["hair", "grooming: a haircut, a barber, a beauty appointment"],
  ["glasses", "eyes: glasses, contact lenses, an optician"],
  ["plane", "a flight or a trip by air: tickets, a booking, check-in"],
  [
    "car",
    "a car: buying, renting, servicing, registration, a parking fine, a taxi",
  ],
  ["train", "public transport and trains: a ticket, a pass, a commute"],
  ["bike", "a bicycle or a scooter: buying, repairing, a rental"],
  [
    "suitcase",
    "a trip being prepared: a holiday, packing, an itinerary, a hotel booking",
  ],
  [
    "map",
    "finding a way or a place to live: directions, a neighbourhood, a route to plan",
  ],
  [
    "place",
    "one place to go to: an address to visit, an office, an errand somewhere",
  ],
  [
    "world",
    "abroad: another country, a currency, an international move, a language",
  ],
  ["tent", "camping and nature trips: a hike, a campsite, outdoor gear"],
  ["food", "a meal out or a restaurant: a table to book, a dinner, catering"],
  ["coffee", "a coffee or an informal meet-up with someone"],
  ["wine", "drinks and wine: a bar, a bottle to buy, a tasting"],
  [
    "iphone",
    "a phone or a mobile app: a new phone, a repair, an app to install on it",
  ],
  [
    "wifi",
    "internet and network: a broadband contract, a router, a connection problem",
  ],
  ["camera", "photos and video: a shoot, a camera, pictures to sort or print"],
  ["tv", "television and streaming: a TV, a streaming subscription, a show"],
  ["music", "music: a concert, tickets, an instrument, a playlist"],
  ["game", "games: a console, a video game, a game night"],
  ["headphones", "audio gear: headphones, speakers, a microphone, a podcast"],
  ["printer", "printing and scanning: a printer, documents to print or scan"],
  ["pet", "a pet: the vet, food, someone to look after it"],
  [
    "flag",
    "a goal or a milestone with no better icon: a target, a challenge, a resolution",
  ],
  ["folder", "none of the above: the fallback"],
] as const;

/** A key of `MATTER_ICONS`. */
export const MatterIconKey = z.enum(MATTER_ICONS.map(([key]) => key));
export type MatterIconKey = z.infer<typeof MatterIconKey>;

/** One line of memory/matter-icons.jsonl: Life's pick for one matter text (`iconInputsOf`), null when none fits. */
export const MatterIconPick = z
  .object({
    at: isoDateTime,
    icon: MatterIconKey.nullable(),
    inputs: z.string(),
    madeBy: MadeBy,
    schemaVersion: z.literal(1),
  })
  .strict();
export type MatterIconPick = z.infer<typeof MatterIconPick>;
