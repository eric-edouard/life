// Reading Apple's binary property lists (`bplist00`), which apps keep in their stores (Photos' reverse-geocoded
// addresses). Reads what those hold: booleans, numbers, dates (as numbers), strings, data, arrays, dictionaries and the references an
// NSKeyedArchiver archive links its objects by (`Uid`).

export interface Uid {
  uid: number;
}
export type Plist =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | Uid
  | Plist[]
  | { [key: string]: Plist };

const MAGIC = "bplist00";
const TRAILER = 32;
/** The marker byte holds an object's type in its high four bits and its size (or a size's width) in its low four. */
const NIBBLE = 16;
const SIZE_FOLLOWS = 15;

/** The value a binary property list holds. Throws on anything else, or a type this does not read. */
export function readBplist(bytes: Uint8Array): Plist {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (new TextDecoder().decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) {
    throw new Error("not a binary property list");
  }
  const trailer = bytes.byteLength - TRAILER;
  const offsetSize = view.getUint8(trailer + 6);
  const refSize = view.getUint8(trailer + 7);
  const table = Number(view.getBigUint64(trailer + 24));
  const uint = (at: number, size: number) => {
    let n = 0;
    for (let i = 0; i < size; i += 1) {
      n = n * 256 + view.getUint8(at + i);
    }
    return n;
  };
  /** An object whose size is in its marker, or after it when that is `SIZE_FOLLOWS`: where its content starts, and its size. */
  const sized = (at: number, low: number) => {
    if (low !== SIZE_FOLLOWS) {
      return { at, size: low };
    }
    const width = 2 ** (view.getUint8(at) % NIBBLE);
    return { at: at + 1 + width, size: uint(at + 1, width) };
  };
  /** Data, strings, arrays and dictionaries: objects with a size. */
  const container = (type: number, next: number, low: number): Plist => {
    const { at, size } = sized(next, low);
    const ref = (i: number) => read(uint(at + i * refSize, refSize));
    switch (type) {
      case 4:
        return bytes.subarray(at, at + size);
      case 5:
        return new TextDecoder().decode(bytes.subarray(at, at + size));
      case 6:
        return new TextDecoder("utf-16be").decode(
          bytes.subarray(at, at + size * 2)
        );
      case 10:
        return Array.from({ length: size }, (_, i) => ref(i));
      case 13:
        return Object.fromEntries(
          Array.from({ length: size }, (_, i) => [
            ref(i) as string,
            ref(size + i),
          ])
        );
      default:
        throw new Error(`binary property list type ${type} not read`);
    }
  };
  function read(index: number): Plist {
    const start = uint(table + index * offsetSize, offsetSize);
    const marker = view.getUint8(start);
    const [type, low] = [Math.floor(marker / NIBBLE), marker % NIBBLE];
    const next = start + 1;
    switch (type) {
      case 0:
        return low === 0 ? null : low === 9;
      case 1:
        return uint(next, 2 ** low);
      case 2:
        return low === 3 ? view.getFloat64(next) : view.getFloat32(next);
      case 3:
        return view.getFloat64(next);
      case 8:
        return { uid: uint(next, low + 1) };
      default:
        return container(type, next, low);
    }
  }
  return read(Number(view.getBigUint64(trailer + 16)));
}
