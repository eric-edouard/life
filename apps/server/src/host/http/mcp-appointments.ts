import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { openAppointment, readsOnce } from "../../memory/find-refs";
import { AppointmentId } from "../../records/appointment";
import { PUSH_ID } from "../../sources/voice-server-push";
import {
  removeAppointment,
  restoreAppointment,
} from "../appointments-calendar";
import { NOT_HIS, REVERSIBLE, tool } from "./mcp-tool";

/** Registers the appointments Life added to his calendar: `read_appointments` (the event sheet) and his Remove or Undo. */
export function appointmentTools(server: McpServer) {
  tool(
    server,
    "read_appointments",
    "One appointment Life keeps in his calendar (an event it added, marked `(Life)`), by its push's `pushId` (16 hex) or its id (`apt_…`), JSON: `appointment`, `pushId`, `title`, `startsAt` and `endsAt` (instants, or days when `allDay`; the end exclusive), `where`, `link` (a meeting link copied from the messages), `from` (the message it was read from: `chat`, `message` ref, `sender` (a party), `at`, `text`; null when Life can't open it), `matterId`, `addedAt` (its first event), `removedAt` (when he removed it; null while it is in his calendar).",
    z.object({
      appointment: AppointmentId.optional(),
      pushId: z.string().regex(PUSH_ID).optional(),
    }),
    async (q) => {
      if ((q.appointment === undefined) === (q.pushId === undefined)) {
        throw new Error("Give `appointment` or `pushId`, one of the two.");
      }
      const found = await openAppointment(q, readsOnce());
      if (!found) {
        throw new Error("No such appointment.");
      }
      return found;
    }
  );
  tool(
    server,
    "change_appointment",
    "His Remove or Undo of an appointment Life added to his calendar, only on his own tap or words: `remove` deletes its event (already gone counts) and Life never writes it again; `restore` lifts that and writes it again. `result`: `removed`, `restored`, or `failed` with its `reason` (then nothing changed).",
    z.object({
      action: z.enum(["remove", "restore"]),
      appointment: AppointmentId,
    }),
    ({ action, appointment }, agent) => {
      if (agent) {
        throw new Error(NOT_HIS);
      }
      return action === "remove"
        ? removeAppointment(appointment)
        : restoreAppointment(appointment);
    },
    REVERSIBLE
  );
}
