import { main } from "../host/cli";
import { desk } from "./desk-helper";

// Life's command line and the app's helper binary: host's commands and the desk's, from the top layer (nothing
// imports the desk).

await main({ desk });
