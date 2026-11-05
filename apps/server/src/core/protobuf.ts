// Reading the protobuf messages that apps keep in their stores (Screen Time's records, WhatsApp's call details).

export type Field = number | Uint8Array;
/** A protobuf message's fields by number (the last one wins): varints and doubles as numbers, the rest as bytes. */
export function fieldsOf(buf: Uint8Array) {
  const fields = new Map<number, Field>();
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  const varint = () => {
    let n = 0;
    for (let shift = 1; ; shift *= 128) {
      const x = buf[i] ?? 0;
      i += 1;
      n += (x % 128) * shift;
      if (x < 128 || i >= buf.length) {
        return n;
      }
    }
  };
  while (i < buf.length) {
    const key = varint();
    const wire = key % 8;
    const field = Math.floor(key / 8);
    if (wire === 0) {
      fields.set(field, varint());
    } else if (wire === 1) {
      fields.set(field, view.getFloat64(i, true));
      i += 8;
    } else if (wire === 2) {
      const n = varint();
      fields.set(field, buf.subarray(i, i + n));
      i += n;
    } else if (wire === 5) {
      i += 4;
    } else {
      break;
    }
  }
  return fields;
}
