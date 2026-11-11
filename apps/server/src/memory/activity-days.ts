import { MIN, minutes } from "../core/clock";
import { count } from "../core/lists";
import { redact } from "../core/redact";
import type { SourceEvent } from "../records/source";
import { addressBeyond, ocrText } from "../sources/photos";
import { WEB } from "../sources/screen";
import { offsetAt, time } from "./zones";

/** A device-day's stints this long are its lines; shorter ones count in its totals only. */
const LINE_STINT = 5 * MIN;

/** A device-day's time by app and website, then stints of 5 minutes or more; its headline counts app time. */
export function deviceDayText(list: SourceEvent[]) {
  const sorted = list.toSorted((a, b) => a.at.localeCompare(b.at));
  const length = (e: SourceEvent) =>
    Date.parse(e.until ?? e.at) - Date.parse(e.at);
  const lines = sorted.filter((e) => length(e) >= LINE_STINT);
  const totals = [...Map.groupBy(sorted, (e) => e.text)]
    .map(([what, l]) => ({ ms: l.reduce((n, e) => n + length(e), 0), what }))
    .filter((t) => t.ms >= MIN)
    .sort((a, b) => b.ms - a.ms);
  const apps = totals.filter((t) => !t.what.startsWith(WEB));
  const [top] = apps;
  const body = [
    `Time: ${totals.map((t) => `${t.what} ${minutes(t.ms)}`).join(", ")}`,
    ...lines.map((e) => `${time(e.at)}–${time(e.until ?? e.at)} ${e.text}`),
  ].join("\n");
  const headline = `${minutes(apps.reduce((n, t) => n + t.ms, 0))} in apps${top ? `, most ${top.what} ${minutes(top.ms)}` : ""}`;
  return { body, headline, lines };
}

/** A measurement-day's nights and workouts, each with its own start and end. */
export function measurementDayText(list: SourceEvent[]) {
  const lines = list.toSorted((a, b) => a.at.localeCompare(b.at));
  const body = lines
    .map((e) => `${time(e.at)}–${time(e.until ?? e.at)} ${e.text}`)
    .join("\n");
  return { body, headline: lines.map((e) => e.text).join("; "), lines };
}

/** Photos taken this long after the one before, or somewhere else, are another line of their day. */
const PHOTO_GAP = 30 * MIN;
/** The scene labels a line of photos shows: the most common among them. */
const SCENES_SHOWN = 5;

/** The most common of `values`, first seen first among equals. */
const commonest = (values: string[], n: number) =>
  [...Map.groupBy(values, (v) => v)]
    .toSorted((a, b) => b[1].length - a[1].length)
    .slice(0, n)
    .map(([v]) => v);

/** "2 photos, 1 video". */
function tally(photos: { video?: true }[]) {
  const videos = photos.filter((p) => p.video).length;
  return [
    ...(photos.length > videos ? [count(photos.length - videos, "photo")] : []),
    ...(videos > 0 ? [count(videos, "video")] : []),
  ].join(", ");
}

/** One line of a photo-day: photos taken together at one place, with what Photos and he say of them. */
function photoLine(group: SourceEvent[]) {
  const first = group[0] as SourceEvent;
  const last = group.at(-1) as SourceEvent;
  const photos = group.flatMap((e) => (e.photo ? [e.photo] : []));
  const located = photos.find((p) => p.point || p.address);
  const names = photos.flatMap((p) => p.pictured.map((x) => x.name));
  const favorites = photos.filter((p) => p.favorite).length;
  // Photos names a zone "GMT+0700", never as Life does: it shows only when its offset is not the one Life dated the day in.
  const zones = new Set(
    group.flatMap((e) =>
      e.photo?.zone &&
      e.photo.offset !== undefined &&
      e.photo.offset * 1000 !== offsetAt(e.at)
        ? [e.photo.zone]
        : []
    )
  );
  const words = ocrText([...new Set(photos.flatMap((p) => p.ocr ?? []))]);
  return [
    time(first.at) === time(last.at)
      ? time(first.at)
      : `${time(first.at)}–${time(last.at)}`,
    first.photo?.place,
    addressBeyond({ address: located?.address, place: first.photo?.place }),
    located?.point &&
      `${located.point.lat.toFixed(4)}, ${located.point.lon.toFixed(4)}`,
    tally(photos),
    commonest(
      photos.flatMap((p) => p.scenes),
      SCENES_SHOWN
    ).join(", "),
    names.length > 0 && `with ${[...new Set(names)].join(", ")}`,
    favorites > 0 && `★ ${favorites}`,
    zones.size > 0 && `zone ${[...zones].join(", ")}`,
    ...photos.flatMap((p) => (p.caption ? [`"${p.caption}"`] : [])),
    words && `text: ${words}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * A photo-day: its photos in lines of those taken within half an hour at one place (his library's moment), each with the
 * place, address and coordinates, how many, the commonest scenes, who is pictured, favourites, a zone Life did not date
 * the day in, his captions and the words found in them. Redacted, as the words of any source are.
 */
export function photoDayText(list: SourceEvent[]) {
  const lines = list.toSorted((a, b) => a.at.localeCompare(b.at));
  const groups: SourceEvent[][] = [];
  for (const e of lines) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    if (
      group &&
      previous &&
      Date.parse(e.at) - Date.parse(previous.at) <= PHOTO_GAP &&
      previous.photo?.place === e.photo?.place
    ) {
      group.push(e);
    } else {
      groups.push([e]);
    }
  }
  const places = [...new Set(lines.flatMap((e) => e.photo?.place ?? []))];
  return {
    body: redact(groups.map(photoLine).join("\n")),
    headline: [tally(lines.flatMap((e) => e.photo ?? [])), places.join(", ")]
      .filter(Boolean)
      .join(" · "),
    lines,
  };
}
