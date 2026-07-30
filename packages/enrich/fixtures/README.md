# Cassettes

A cassette is a recorded provider conversation. It lets the whole enrichment
pipeline — policy, redaction, the transport guard, validation, caching, and
storage — run end to end with no network and no API key.

That exists for two reasons, and the second shaped the design. The first is
that a test suite requiring a credential is a test suite that gets skipped, and
the skipped tests are always the ones covering the code that spends money. The
second is contribution: somebody improving a prompt should not have to fund an
OpenAI account to see whether their change works. Requiring a key to develop
enrichment does not merely inconvenience contributors, it selects which
contributors exist.

## Using one

```bash
CAREERFORGE_CASSETTE=./my-cassette.json careerforge enrich --unit <id>
```

Every run answered from a cassette is labelled `RECORDED` in the output.
Recorded output that looked like a live answer would be a lie in the audit
trail.

## Shape

```json
{
  "entries": [
    {
      "name": "skills for the parser work",
      "match": {
        "schemaName": "skills",
        "model": "gpt-5",
        "payload": "[evidence 01EV1]\nRewrote the JSONL reader",
        "promptHash": "optional; checked when present"
      },
      "response": {
        "value": {
          "skills": [
            { "name": "...", "category": "engineering", "rationale": "...", "evidence": ["01EV1"] }
          ]
        },
        "model": "gpt-5-2026-02-01",
        "usage": { "inputTokens": 120, "outputTokens": 45 }
      }
    }
  ]
}
```

`match.payload` is the exact text the policy engine produced — redacted, with
`[evidence <id>]` markers. Matching on the payload rather than on a work unit
id means a cassette keeps answering after ids change, which they do every time
a fixture store is rebuilt.

`match.promptHash` is optional so a hand-written fixture stays hand-writable.
When present it is checked, which is what makes a captured cassette precise
about the prompt version it recorded: edit the prompt and the recording stops
answering rather than quietly answering for the wrong text.

`response.model` is what the provider says actually answered, which is
routinely more specific than what was asked for. Recording the request instead
would make the run record subtly untrue — and it is exactly the field that
detects a model being upgraded underneath you.

## Capturing one

Run a dry run against the work unit you want, take the payload it prints, and
build the entry around it:

```bash
careerforge enrich --unit <id> --provider ollama --dry-run
```

A recorded provider never guesses. When nothing matches it refuses with
`no_recording` rather than falling back, because a silent fallback would let a
test assert on an answer nobody recorded.

## What must never be committed here

Real session transcripts. They contain credentials, client names, file
contents, and unguarded opinions. Cassette payloads must be **structurally
real, textually synthetic** — the same shape a real payload has, with content
nobody would mind reading aloud.
