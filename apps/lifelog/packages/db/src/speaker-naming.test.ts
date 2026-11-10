import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { clock } from "@life/server/src/core/clock";
import { connect, MIGRATIONS, migrateDb } from "./index";
import { namingAttempts, people } from "./schema";

test("naming migration preserves existing people and owner assignments", async () => {
  const client = new Database(":memory:");
  try {
    const journal: { entries: { tag: string }[] } = await Bun.file(
      join(MIGRATIONS, "meta/_journal.json")
    ).json();
    const latest = journal.entries.at(-1);
    if (!latest) {
      throw new Error("missing naming migration");
    }
    const earlier = await Promise.all(
      journal.entries
        .slice(0, -1)
        .map((entry) => Bun.file(join(MIGRATIONS, `${entry.tag}.sql`)).text())
    );
    for (const migration of earlier) {
      client.exec(migration);
    }
    const at = clock().getTime();
    client.run(
      "insert into people (id, name, aliases, is_owner, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ["person", "Aster", '["Ash"]', 0, at, at]
    );
    client.run(
      "insert into speaker_assignments (id, job_id, speaker_label, person_id, source, status, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      ["assignment", "job", "speaker_0", "person", "owner", "person", at]
    );
    client.exec(await Bun.file(join(MIGRATIONS, `${latest.tag}.sql`)).text());
    expect(
      client
        .query(
          "select name, aliases, creation_source, name_source, life_ref from people"
        )
        .get()
    ).toEqual({
      aliases: '["Ash"]',
      creation_source: "owner",
      life_ref: null,
      name: "Aster",
      name_source: "owner",
    });
    expect(
      client
        .query("select person_id, source, inference from speaker_assignments")
        .get()
    ).toEqual({
      inference: null,
      person_id: "person",
      source: "owner",
    });
  } finally {
    client.close();
  }
});

test("canonical Life references and conversation inputs are unique", () => {
  const db = connect(":memory:");
  try {
    migrateDb(db);
    db.insert(people).values({ lifeRef: "life:aster", name: "Aster" }).run();
    expect(() =>
      db.insert(people).values({ lifeRef: "life:aster", name: "Other" }).run()
    ).toThrow();
    const input = {
      conversationId: "conversation",
      inputHash: "input",
      model: "synthetic",
      policyHash: "policy",
      promptHash: "prompt",
      snapshotRevision: 1,
    };
    db.insert(namingAttempts).values(input).run();
    expect(() => db.insert(namingAttempts).values(input).run()).toThrow();
    db.insert(namingAttempts)
      .values({ ...input, inputHash: "changed" })
      .run();
  } finally {
    db.$client.close(true);
  }
});
