/**
 * Refusals: saying no in a way somebody can act on.
 *
 * CareerForge refuses often and on purpose. It will not infer that you led
 * something, it will not invent a number, and it will not send restricted work
 * to a provider you have not approved. Every one of those is correct, and
 * every one of them is useless to a user who is told only that the answer is
 * no.
 *
 * So a refusal is a record with a shape, not a message:
 *
 *   code    stable and machine-readable
 *   rule    which named, versioned rule decided
 *   reason  a plain sentence saying what is wrong
 *   remedy  what would have to change for the answer to be yes
 *
 * The remedy is the part that matters and the part usually missing. A system
 * that refuses without one is an obstacle; a system that names the next step
 * is a guide, and the difference is whether the user learns anything about
 * their own evidence.
 *
 * A test asserts that every refusal the system can produce carries an
 * actionable remedy, so this stays true as refusals are added.
 */

/**
 * What would change the answer.
 *
 * A closed union, because "what should I do about this?" must be answerable
 * for every refusal. Adding a refusal without deciding its remedy is a
 * compile error rather than a gap someone finds later.
 */
export type Remedy =
  | {
      /** Answer a question CareerForge cannot answer for you. */
      readonly kind: 'confirm';
      /** The evidence class that would satisfy the rule. */
      readonly needs: 'user_confirmed';
      /** The question to put, ready to show. */
      readonly question: string;
    }
  | {
      /** Collect or compute evidence that carries the asserted value. */
      readonly kind: 'evidence';
      readonly needs: 'imported' | 'derived' | 'corroborating';
      readonly detail: string;
    }
  | {
      /** Grant consent for this project and provider at this level. */
      readonly kind: 'grant';
      readonly projectKey: string | null;
      readonly providerId: string;
      readonly level: string;
      /** The exact command that would do it. */
      readonly command: string;
    }
  | {
      /** Send to a provider that runs on this machine instead. */
      readonly kind: 'use_local_provider';
      readonly detail: string;
    }
  | {
      /** Remove or narrow the offending content before sending. */
      readonly kind: 'reduce_payload';
      readonly detail: string;
    }
  | {
      /**
       * Nothing the user can do, and saying so plainly is the honest answer.
       *
       * Rare by design. If this becomes common, the rule producing it is
       * probably wrong.
       */
      readonly kind: 'not_possible';
      readonly detail: string;
    };

export interface Refusal {
  /** Stable across releases; safe to switch on. */
  readonly code: string;
  /** The named, versioned rule that decided. `restricted-default@1`. */
  readonly rule: string;
  /** One sentence, in words a user would use. */
  readonly reason: string;
  readonly remedy: Remedy;
}

/** Whether a remedy tells the user something they can actually do. */
export function isActionable(remedy: Remedy): boolean {
  return remedy.kind !== 'not_possible';
}

/**
 * A refusal rendered as the two lines a person needs.
 *
 * Kept in the domain so every surface — CLI, UI, and whatever comes next —
 * says the same thing rather than each inventing its own phrasing.
 */
export function explainRefusal(refusal: Refusal): { readonly why: string; readonly next: string } {
  return { why: refusal.reason, next: describeRemedy(refusal.remedy) };
}

export function describeRemedy(remedy: Remedy): string {
  switch (remedy.kind) {
    case 'confirm':
      return `Answer this and CareerForge can use it: ${remedy.question}`;
    case 'evidence':
      return `This needs ${remedy.needs} evidence. ${remedy.detail}`;
    case 'grant':
      return `Allow it for this project with: ${remedy.command}`;
    case 'use_local_provider':
      return `Use a provider that runs on this machine. ${remedy.detail}`;
    case 'reduce_payload':
      return `Send less. ${remedy.detail}`;
    case 'not_possible':
      return remedy.detail;
  }
}
