// What a time zone is, imported by lifelog's server too: no import of its own, so it carries no Life module along.

// An IANA name Intl knows, never an offset ("+07:00"): his days follow the zone's rules.
const ZONE_NAME = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/;
/** Is `zone` an IANA time zone Intl knows? */
export function isTimeZone(zone: string) {
  try {
    // Throws a RangeError for a zone it doesn't know.
    return (
      ZONE_NAME.test(zone) &&
      Boolean(new Intl.DateTimeFormat("en", { timeZone: zone }))
    );
  } catch {
    return false;
  }
}
