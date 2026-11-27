// The home-screen app's list sheet: how a swipe down on it is read. Pure, so it is tested without a page.

/** How far down a swipe on the open sheet closes it, in pixels. */
const CLOSES_AT = 80;

/** How far a swipe that started at `from` has dragged the sheet down at `y`: never up. */
export const dragOf = (from: number, y: number) => Math.max(0, y - from);

/** Whether a swipe that ended this far down closes the sheet. */
export const isClosingDrag = (drag: number) => drag > CLOSES_AT;
