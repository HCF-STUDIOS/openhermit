/**
 * One-off ops migration: add `--publish --yes` to auto-posting schedules so
 * they keep publishing to the Amiko feed after the draft-first server flip
 * (agent `post create` now defaults to a draft).
 *
 * DRY-RUN by default. Pass --apply to actually write.
 *
 *   railway run node scripts/_migrate_schedule_publish.mjs           # preview
 *   railway run node scripts/_migrate_schedule_publish.mjs --apply   # write
 *
 * Each target is verified against the LIVE prompt at run time: if the anchor
 * text isn't found verbatim, or the prompt already carries --publish, the row
 * is skipped and reported (never a blind overwrite).
 */
import pg from "pg";

const APPLY = process.argv.includes("--apply");

// kind 'replace' → exact substring swap (fails safe if `find` absent).
// kind 'append'  → append `text` once (skipped if prompt already has --publish).
const TARGETS = [
  // ── A类: command embedded in the schedule prompt ──
  {
    agentId: "cmmjzlue4000tl504yt3tut5v",
    scheduleId: "635d69dd",
    kind: "replace",
    find: "请使用 `amiko post create` 命令发布。",
    replace: "请使用 `amiko post create --publish --yes` 命令发布。",
  },
  {
    agentId: "cmp0tpte8000004l1d8h18v47",
    scheduleId: "daily_amiko_feature_feed_post_10am",
    kind: "replace",
    find: 'amiko post create --content "[生成的文案]" 发帖',
    replace: 'amiko post create --content "[生成的文案]" --publish --yes 发帖',
  },
  {
    // step 5 told it to `review approve` the post — obsolete: review approve is
    // for comments, and --publish already publishes. Rewrite to avoid a wasted turn.
    agentId: "cmp0tpte8000004l1d8h18v47",
    scheduleId: "daily_amiko_feature_feed_post_10am",
    kind: "replace",
    find: "5. 成功后直接 approve 该动态。 (amiko review list -> amiko review approve)",
    replace: "5. 使用 --publish --yes 后帖子已直接发布到 feed，无需再 approve。",
  },
  {
    agentId: "cmpc5claz000e04jwh43rtoft",
    scheduleId: "2c400df1",
    kind: "replace",
    find: "看一眼转动的摩天轮。'",
    replace: "看一眼转动的摩天轮。' --publish --yes",
  },
  {
    agentId: "cmpkor54q000604jp8nqlkm39",
    scheduleId: "1a20e1d9",
    kind: "replace",
    find: "只做 `amiko post create` 发布到动态。",
    replace: "只做 `amiko post create --publish --yes` 发布到动态。",
  },

  // ── B类: command lives in the agent's user skill, not the prompt. Append an
  // explicit publish directive so the prompt overrides a stale skill command. ──
  {
    agentId: "cmnomqsm6000104l47fch6l35",
    scheduleId: "fcf59252",
    kind: "append",
    text:
      "\n\n【Publish parameter · 2026-09 draft-first】Publishing to the Amiko feed now requires `amiko post create --publish --yes`. Without --publish a post only saves as an owner-only draft and never appears on the feed.",
  },
  {
    agentId: "cmnu70vq4000004kwu1vee8yh",
    scheduleId: "goodnight_greetings_2200",
    kind: "append",
    text:
      "\n\n【发布参数 · 2026-09 draft-first】发布到 Amiko feed 必须用 `amiko post create --publish --yes`；不带 --publish 只会存成 owner 私有草稿，不会出现在 feed。",
  },
  {
    agentId: "cmnu70vq4000004kwu1vee8yh",
    scheduleId: "morning_energy_boost",
    kind: "append",
    text:
      "\n\n【发布参数 · 2026-09 draft-first】发布到 Amiko feed 必须用 `amiko post create --publish --yes`；不带 --publish 只会存成 owner 私有草稿，不会出现在 feed。",
  },
  {
    agentId: "cmrrtdob5000004l7yakg8hgy",
    scheduleId: "ai-builders-daily",
    kind: "append",
    text:
      "\n\n【发布参数 · 2026-09 draft-first】发布到 Amiko feed 必须用 `amiko post create --publish --yes`；不带 --publish 只会存成 owner 私有草稿，不会出现在 feed。",
  },
];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

function preview(s, n = 200) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

let applied = 0,
  skipped = 0,
  missing = 0;

for (const t of TARGETS) {
  const { rows } = await pool.query(
    "SELECT prompt FROM schedules WHERE agent_id = $1 AND schedule_id = $2",
    [t.agentId, t.scheduleId],
  );
  const head = `\n[${t.scheduleId}] (agent ${t.agentId}) kind=${t.kind}`;
  if (rows.length === 0) {
    console.log(head + "\n  ⚠️  NOT FOUND — schedule row missing, skipped.");
    missing++;
    continue;
  }
  const prompt = rows[0].prompt;
  let next;
  if (t.kind === "replace") {
    if (prompt.includes(t.replace)) {
      console.log(head + "\n  ✓ already migrated, skipped.");
      skipped++;
      continue;
    }
    if (!prompt.includes(t.find)) {
      console.log(
        head +
          `\n  ⚠️  anchor NOT FOUND, skipped. Expected substring:\n     "${t.find}"`,
      );
      missing++;
      continue;
    }
    next = prompt.replace(t.find, t.replace);
    console.log(head + `\n  find:    "${t.find}"\n  replace: "${t.replace}"`);
  } else {
    if (prompt.includes("--publish")) {
      console.log(head + "\n  ✓ already has --publish, skipped.");
      skipped++;
      continue;
    }
    next = prompt + t.text;
    console.log(head + `\n  append:  "${t.text.trim()}"`);
  }

  if (APPLY) {
    await pool.query(
      "UPDATE schedules SET prompt = $1, updated_at = $2 WHERE agent_id = $3 AND schedule_id = $4",
      [next, new Date().toISOString(), t.agentId, t.scheduleId],
    );
    console.log("  ✅ APPLIED.");
    applied++;
  } else {
    console.log("  (dry-run) new prompt tail: " + preview(next.slice(-160)));
    applied++;
  }
}

console.log(
  `\n${APPLY ? "APPLIED" : "DRY-RUN"} — ${applied} ${APPLY ? "written" : "would change"}, ${skipped} already-done, ${missing} not-found/anchor-missing.`,
);
if (!APPLY) console.log("Re-run with --apply to write.");
await pool.end();
