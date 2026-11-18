// The same queue/card/projection builders, on one read-only connection for this worker's lifetime.
import { connect } from "@lifelog/db";
import { latestSeq } from "./change-log";
import { namingQueue } from "./naming-queue";

declare const self: Worker;
let db: ReturnType<typeof connect>;
let queue: ReturnType<typeof namingQueue>;
self.onmessage = ({ data }: MessageEvent<string | null>) => {
  if (data !== null) {
    db = connect(data, { readonly: true });
    queue = namingQueue(db);
  }
  // Revision and rows belong to one SQLite snapshot; naming writes can proceed through WAL.
  const result = db.transaction(() => {
    const seen = latestSeq(db);
    return { map: queue.projection(), seen };
  });
  self.postMessage(result);
};
process.on("exit", () => db?.$client.close(true));
