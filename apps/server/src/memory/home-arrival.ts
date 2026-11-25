import { join } from "node:path";
import { readJson } from "../core/files";
import { OUT } from "./memory-files";

/** His last arrival home the desk saw, while a Later waited for it (`recordArrivalHome`): Life's state, never his data. */
export const HOME_ARRIVAL = join(OUT, "home-arrival.json");

/** When he last arrived home, as the desk saw it; none before. */
export const readHomeArrival = () =>
  readJson<{ at?: string }>(HOME_ARRIVAL)?.at;
