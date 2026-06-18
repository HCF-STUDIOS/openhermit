import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  transcodeGroupMentions,
  extractMentionRefs,
  stripLeadingSpeakerTag,
  type GroupParticipant,
} from '../src/agent-runner/message-utils.js';

const ROSTER: GroupParticipant[] = [
  { id: 'u1', type: 'user', displayName: 'Ayush', handle: 'shydev' },
  { id: 'u2', type: 'user', displayName: 'Marty', handle: 'marty' },
  // Twins have no handle, so they can only be matched by display name.
  { id: 'a2', type: 'agent', displayName: 'Titan' },
  { id: 'a3', type: 'agent', displayName: 'Leandro Gavidia' },
];

describe('transcodeGroupMentions: rewrites @Name to platform mention markup', () => {
  test('rewrites a bare @DisplayName', () => {
    assert.equal(transcodeGroupMentions('@Marty hi', ROSTER), '@[Marty](u2:user) hi');
  });

  test('rewrites a twin by display name even though it has no handle', () => {
    assert.equal(transcodeGroupMentions('hey @Titan you there', ROSTER), 'hey @[Titan](a2:agent) you there');
  });

  test('rewrites a multi-word display name', () => {
    assert.equal(transcodeGroupMentions('@Leandro Gavidia said hi', ROSTER), '@[Leandro Gavidia](a3:agent) said hi');
  });

  test('rewrites a @handle for a user whose handle differs from the display name', () => {
    assert.equal(transcodeGroupMentions('@shydev check this', ROSTER), '@[Ayush](u1:user) check this');
  });

  test('rewrites the bracketed @[Name] the model sometimes emits', () => {
    assert.equal(transcodeGroupMentions('@[Marty] hey', ROSTER), '@[Marty](u2:user) hey');
  });

  test('matches case-insensitively but renders the stored display name', () => {
    assert.equal(transcodeGroupMentions('@marty @TITAN', ROSTER), '@[Marty](u2:user) @[Titan](a2:agent)');
  });

  test('matches a unicode display name', () => {
    const roster: GroupParticipant[] = [{ id: 'z', type: 'user', displayName: '李雷' }];
    assert.equal(transcodeGroupMentions('@李雷 hi', roster), '@[李雷](z:user) hi');
  });
});

describe('transcodeGroupMentions: leaves non-mentions and protected spans alone', () => {
  test('an unknown name is untouched', () => {
    assert.equal(transcodeGroupMentions('@nobody hi', ROSTER), '@nobody hi');
  });

  test('an already-formatted mention is left unchanged', () => {
    const input = '@[Marty](u2:user) hi';
    assert.equal(transcodeGroupMentions(input, ROSTER), input);
  });

  test('an email address is not treated as a mention', () => {
    const input = 'reach me at foo@marty.com';
    assert.equal(transcodeGroupMentions(input, ROSTER), input);
  });

  test('a name that is a prefix of a longer token does not match', () => {
    const roster: GroupParticipant[] = [{ id: 'x', type: 'user', displayName: 'Sam' }];
    assert.equal(transcodeGroupMentions('@samuel hi', roster), '@samuel hi');
  });

  test('a hyphen / slash / unicode continuation is not a partial match', () => {
    const roster: GroupParticipant[] = [{ id: 'm', type: 'user', displayName: 'Marty', handle: 'marty' }];
    assert.equal(transcodeGroupMentions('@marty-smith hi', roster), '@marty-smith hi');
    assert.equal(transcodeGroupMentions('install @marty/sdk', roster), 'install @marty/sdk');
    const sam: GroupParticipant[] = [{ id: 's', type: 'user', displayName: 'Sam' }];
    assert.equal(transcodeGroupMentions('@Samé hi', sam), '@Samé hi');
  });

  test('does not rewrite inside an inline code span', () => {
    assert.equal(transcodeGroupMentions('use `@Marty` literally', ROSTER), 'use `@Marty` literally');
  });

  test('does not rewrite inside a fenced code block', () => {
    const input = '```\n@Marty\n```';
    assert.equal(transcodeGroupMentions(input, ROSTER), input);
  });

  test('does not corrupt a markdown link containing a name', () => {
    const input = '[ping @Marty](https://x.test)';
    assert.equal(transcodeGroupMentions(input, ROSTER), input);
  });

  test('does not rewrite inside a double-backtick inline code span', () => {
    assert.equal(transcodeGroupMentions('use ``@Marty`` literally', ROSTER), 'use ``@Marty`` literally');
  });

  test('does not rewrite inside an UNCLOSED fenced code block (runs to end)', () => {
    const input = '```\n@Marty here';
    assert.equal(transcodeGroupMentions(input, ROSTER), input);
  });

  test('leaves a name containing bracket/paren chars as plain text (no malformed markup)', () => {
    const roster: GroupParticipant[] = [{ id: 'x', type: 'user', displayName: 'a]b' }];
    assert.equal(transcodeGroupMentions('@a]b hi', roster), '@a]b hi');
  });

  test('an ambiguous name shared by two participants is left as plain text', () => {
    const roster: GroupParticipant[] = [
      { id: 'p1', type: 'user', displayName: 'Sam' },
      { id: 'p2', type: 'agent', displayName: 'Sam' },
    ];
    assert.equal(transcodeGroupMentions('@Sam hi', roster), '@Sam hi');
  });

  test('an empty roster leaves text unchanged', () => {
    assert.equal(transcodeGroupMentions('@Marty hi', []), '@Marty hi');
  });

  test('bails out unchanged when the roster exceeds the participant cap', () => {
    // 257 participants > MAX_MENTION_PARTICIPANTS (256): the regex is never
    // built, so even a valid mention passes through untouched.
    const roster: GroupParticipant[] = Array.from({ length: 257 }, (_, i) => ({
      id: `u${i}`,
      type: 'user',
      displayName: `User${i}`,
    }));
    assert.equal(transcodeGroupMentions('@User0 hi', roster), '@User0 hi');
  });

  test('transcodes up to the participant cap', () => {
    // Exactly 256 participants is within the cap, so @User0 still resolves.
    const roster: GroupParticipant[] = Array.from({ length: 256 }, (_, i) => ({
      id: `u${i}`,
      type: 'user',
      displayName: `User${i}`,
    }));
    assert.equal(transcodeGroupMentions('@User0 hi', roster), '@[User0](u0:user) hi');
  });

  test('skips a token longer than the char cap but still transcodes others', () => {
    const roster: GroupParticipant[] = [
      { id: 'long', type: 'user', displayName: 'A'.repeat(129) },
      { id: 'short', type: 'user', displayName: 'Bo' },
    ];
    const text = `@${'A'.repeat(129)} and @Bo`;
    // The 129-char name (> MAX_MENTION_TOKEN_CHARS) is skipped; @Bo resolves.
    assert.equal(transcodeGroupMentions(text, roster), `@${'A'.repeat(129)} and @[Bo](short:user)`);
  });
});

describe('extractMentionRefs: derives the mention list from rendered markup', () => {
  test('extracts id + type from each roster mention, deduped in order', () => {
    const text = '@[Marty](u2:user) and @[Titan](a2:agent) and @[Marty](u2:user)';
    assert.deepEqual(extractMentionRefs(text, ROSTER), [
      { id: 'u2', type: 'user' },
      { id: 'a2', type: 'agent' },
    ]);
  });

  test('records an already-formatted mention that transcode left untouched', () => {
    const text = transcodeGroupMentions('@[Marty](u2:user) hi', ROSTER);
    assert.deepEqual(extractMentionRefs(text, ROSTER), [{ id: 'u2', type: 'user' }]);
  });

  test('ignores markup whose id is not a current participant (no forged notifications)', () => {
    assert.deepEqual(extractMentionRefs('@[Ghost](u999:user) hi', ROSTER), []);
  });

  test('uses the roster type, not the markup type (wrong-typed tag still resolves)', () => {
    // u2 is a user in ROSTER; markup claims agent. Roster type wins.
    assert.deepEqual(extractMentionRefs('@[Marty](u2:agent) hi', ROSTER), [
      { id: 'u2', type: 'user' },
    ]);
  });

  test('ignores mention markup inside a code span or markdown link', () => {
    assert.deepEqual(extractMentionRefs('use `@[Marty](u2:user)` literally', ROSTER), []);
    assert.deepEqual(extractMentionRefs('[x @[Marty](u2:user)](https://x.test)', ROSTER), []);
  });

  test('returns nothing when there is no mention markup', () => {
    assert.deepEqual(extractMentionRefs('no mentions @nobody here', ROSTER), []);
  });
});

// Mirrors agent-runner's pipeline: strip a copied leading [Name] tag using the
// known names (group senders + roster), transcode @mentions, then derive the
// notification list from the final text. Runs the exact reply from the bug report.
describe('end-to-end on the reported group reply', () => {
  const roster: GroupParticipant[] = [
    { id: 'self', type: 'agent', displayName: 'Leandro Gavidia' },
    { id: 'u1', type: 'user', displayName: 'shydev', handle: 'shydev' },
    { id: 't1', type: 'agent', displayName: 'TwinAndroV23' },
    { id: 't2', type: 'agent', displayName: 'Marty' },
    { id: 't3', type: 'agent', displayName: 'Titan' },
  ];
  const knownNames = roster.map((p) => p.displayName);

  const pipeline = (text: string) => {
    const cleaned = transcodeGroupMentions(stripLeadingSpeakerTag(text, knownNames), roster);
    return { text: cleaned, mentions: extractMentionRefs(cleaned, roster) };
  };

  test('strips the leading [TwinAndroV23] tag and turns @mentions into real markup + notifications', () => {
    const reply =
      '[TwinAndroV23] @shydev, seeing as it is a team effort, I am waiting on ' +
      'Leandro Gavidia to see his picks. @[Marty] prove you are listening. ' +
      '@Titan, you hearing this?';
    const { text, mentions } = pipeline(reply);

    assert.ok(!text.startsWith('[TwinAndroV23]'), 'leading [Name] tag still present');
    assert.ok(text.includes('@[shydev](u1:user)'));
    assert.ok(text.includes('@[Marty](t2:agent)'));
    assert.ok(text.includes('@[Titan](t3:agent)'));
    assert.ok(text.includes('waiting on Leandro Gavidia'));
    assert.ok(!text.includes('@[Leandro Gavidia]'));
    assert.ok(!/@\[[^\]]+\](?!\()/.test(text), 'a malformed @[Name] mention remains');
    assert.deepEqual(mentions, [
      { id: 'u1', type: 'user' },
      { id: 't2', type: 'agent' },
      { id: 't3', type: 'agent' },
    ]);
  });
});
