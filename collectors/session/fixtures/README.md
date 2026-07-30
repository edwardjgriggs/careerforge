# Session collector fixture corpus

Every case here is one transcript and the exact output the collector produces
from it. The corpus grows; it is not expected to be finished.

## Why this exists

The source format changed **14 times in the 30 days** that were measured, and
grew a record type between the survey and the implementation. This collector
will be wrong about the format repeatedly over its life. The corpus is how
being wrong stays cheap: each surprise becomes a permanent case, and no later
refactor can quietly reintroduce it.

## The workflow

**A parser change starts with a fixture, not with the parser.**

1. Add a directory under `cases/`, named for what it guards.
2. Put one `.jsonl` transcript in it. The file name becomes the session id.
3. Run the tests. There is no `expected.json`, so the suite writes one and
   **fails**, telling you to review it.
4. Read the generated `expected.json` line by line. It is a claim about
   someone's career history — if it is wrong, the fixture has just done its
   job before a user ever saw the bug.
5. Only now change the parser, and watch the case go from wrong to right.

Step 3 failing is deliberate. A silently-accepted golden file records whatever
the code did, which makes it a description of the bug rather than a test of
the behaviour.

## What belongs in a fixture

**Structurally real, textually synthetic.** Shapes, field names, and record
orderings are copied faithfully from observed transcripts. The prose, paths,
and names are invented.

**Never commit a real transcript.** Real ones routinely contain credentials,
client names, file contents, and unguarded opinions about colleagues — the
reason this source defaults to `restricted`. A fixture is a public artifact in
an open-source repository, and that is not a decision to make twice.

Real-corpus coverage comes from `corpus.test.ts` instead, which runs against
whatever is on the developer's own machine and commits nothing.

## Coverage

| Case                              | Guards                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `typical-session`                 | The ordinary path: prompt, tools, files, git, attribution                                    |
| `compact-summary-is-not-a-prompt` | A resumed session opens with a model-written summary filed as a `user` record                |
| `minimal-session`                 | One prompt, no tools, no branch                                                              |
| `string-content`                  | `message.content` as a plain string, not an array                                            |
| `tool-results-are-not-prompts`    | Tool output arrives inside a `user` record and must never be read as something a person said |
| `injected-envelopes`              | Harness-injected text stripped, real prompt in the same record kept                          |
| `unknown-record-types`            | Three invented types plus a real one that appeared after the survey                          |
| `unknown-fields`                  | New fields on `user` and `assistant`                                                         |
| `unknown-content-blocks`          | A block type that does not exist yet                                                         |
| `future-version`                  | A version far beyond anything released                                                       |
| `legacy-version`                  | The oldest version observed                                                                  |
| `truncated-final-line`            | The file is still being written                                                              |
| `invalid-json-midfile`            | One unreadable line among good ones                                                          |
| `blank-lines`                     | Whitespace and empty lines between records                                                   |
| `empty-file`                      | Zero bytes                                                                                   |
| `programmatic-session`            | A harness drove the session; no person typed anything                                        |
| `no-human-prompt`                 | Transport records only — nothing was asked                                                   |
| `no-timestamps`                   | Records with nothing to place on a timeline                                                  |
| `paths-outside-workspace`         | Files touched outside `cwd` are counted, never named                                         |
| `session-id-mismatch`             | Records disagreeing with the file name — the file name wins                                  |
| `crlf-line-endings`               | Windows line endings                                                                         |

Line endings in this directory are preserved byte-for-byte
(see `.gitattributes`): `crlf-line-endings` would otherwise be silently
converted into a duplicate of another case, and every expected hash would
differ by platform.
