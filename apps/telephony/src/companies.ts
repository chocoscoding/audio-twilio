/**
 * Companies with a phone number of their own (dedicated line). Filled in by
 * hand for now; a FourPoints-backed CompanySource replaces the list later
 * without the IVR changing.
 *
 * A company's number reaches Twilio either forwarded (it stays with the
 * company's carrier and forwards to a Twilio number FourPoints bought for
 * it) or ported into FourPoints' Twilio account. Either way the call is
 * matched on `twilioNumber`: the number it arrives on (Twilio's signed
 * `To`). Twilio's `ForwardedFrom` is not used: carriers often leave it out.
 *
 * Adding a company:
 *   1. buy the Twilio number (or port theirs), point "A call comes in" at
 *      /voice/org/incoming
 *   2. add an entry below
 *   3. record the welcome (`welcome`, or "Welcome to <companyName>.") and
 *      import it:
 *      node ivr-audio/pipeline.mjs import welcome-org-<orgNumber> <file> "Welcome to <companyName>."
 *
 * Whether the caller must enter an access code is decided by FourPoints
 * (an organization-wide code, active or paused, means yes), not here.
 */

export interface CompanyLine {
  /**
   * The number the call arrives on in Twilio; the only number matched. When
   * callers dial a Twilio number directly (one FourPoints gave the company,
   * or the company's own number ported in), this is that number.
   */
  twilioNumber: string;
  /**
   * Forwarded numbers only: the company's own number, which stays with its
   * carrier and forwards to `twilioNumber`. A record for people, never
   * matched (Twilio's ForwardedFrom is unreliable).
   */
  publicNumber?: string;
}

export interface Company {
  /** The organization number shown in the FourPoints admin console. */
  orgNumber: number;
  /** Must belong to orgNumber; FourPoints checks both, so a typo fails closed. */
  organizationId: string;
  /** Spoken in the welcome: "Welcome to <companyName>." */
  companyName: string;
  lines: readonly CompanyLine[];
  /**
   * The company's own interpreter line (OPI). Human calls ring it with no
   * language menu and no "press 1 to accept" screening. Without it, human
   * calls go to the FourPoints interpreters.
   */
  humanNumber?: string;
  /**
   * The first thing callers hear, when not "Welcome to <companyName>."
   * (e.g. "Thank you for calling Acme Health."). The welcome-org-<orgNumber>
   * clip must say exactly this.
   */
  welcome?: string;
  /**
   * The AI/human menu says the human first: "For a human interpreter,
   * press 1. For an AI interpreter, press 2." Default: AI is 1, human is 2.
   */
  humanFirst?: boolean;
}

export const COMPANIES: readonly Company[] = [
  // {
  //   orgNumber: 123,
  //   organizationId: '00000000-0000-4000-8000-000000000000',
  //   companyName: 'Acme Health',
  //   lines: [
  //     { twilioNumber: '+15557654321' }, // dialed directly
  //     { twilioNumber: '+15557654322', publicNumber: '+18005551234' }, // forwarded
  //   ],
  //   humanNumber: '+18885550000',
  //   welcome: 'Thank you for calling Acme Health.', // optional
  //   humanFirst: true, // optional: 1 = human, 2 = AI
  // },
  {
    // VerbatUm (staging organization 017). Chicago number, dialed directly.
    orgNumber: 17,
    organizationId: '40c9f321-ffb2-4be7-aca6-36669c4fce70',
    companyName: 'VerbatUm',
    lines: [{ twilioNumber: '+18723047712' }],
    // VerbatUm's own live interpreter line.
    humanNumber: '+14342483776',
    welcome: 'Thank you for calling VerbatUm.',
    // VerbatUm's menu: 1 for a live interpreter, 2 for the AI.
    humanFirst: true,
  },
];

export interface CompanySource {
  /** The company whose line a call arrived on (Twilio `To`). */
  byTwilioNumber(number: string | null): Company | undefined;
  byOrgNumber(orgNumber: number): Company | undefined;
}

const E164 = /^\+[1-9]\d{6,14}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class StaticCompanySource implements CompanySource {
  private constructor(
    private readonly byNumber: Map<string, Company>,
    private readonly byOrg: Map<number, Company>,
  ) {}

  static readonly empty = new StaticCompanySource(new Map(), new Map());

  /** Validates the whole list; throws on the first problems found. */
  static from(companies: readonly Company[]): StaticCompanySource {
    const problems: string[] = [];
    const byNumber = new Map<string, Company>();
    const byOrg = new Map<number, Company>();
    for (const company of companies) {
      const name = `company ${company.orgNumber}`;
      if (!Number.isInteger(company.orgNumber) || company.orgNumber < 10) {
        problems.push(`${name}: orgNumber must be an integer >= 10`);
      }
      if (byOrg.has(company.orgNumber)) {
        problems.push(`${name}: orgNumber listed twice`);
      }
      byOrg.set(company.orgNumber, company);
      if (!GUID.test(company.organizationId)) {
        problems.push(`${name}: organizationId must be a UUID`);
      }
      if (company.welcome !== undefined && company.welcome.trim() === '') {
        problems.push(`${name}: welcome is empty`);
      }
      if (company.companyName.trim() === '') {
        problems.push(`${name}: companyName is empty`);
      }
      if (company.lines.length === 0) {
        problems.push(`${name}: needs at least one line`);
      }
      for (const line of company.lines) {
        if (
          !E164.test(line.twilioNumber) ||
          (line.publicNumber !== undefined && !E164.test(line.publicNumber))
        ) {
          problems.push(`${name}: numbers must be in +15551234567 format`);
        }
        if (byNumber.has(line.twilioNumber)) {
          problems.push(`${name}: ${line.twilioNumber} is listed twice`);
        }
        byNumber.set(line.twilioNumber, company);
      }
      if (
        company.humanNumber !== undefined &&
        !E164.test(company.humanNumber)
      ) {
        problems.push(`${name}: humanNumber must be in +15551234567 format`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`Invalid company list:\n  - ${problems.join('\n  - ')}`);
    }
    return new StaticCompanySource(byNumber, byOrg);
  }

  byTwilioNumber(number: string | null): Company | undefined {
    return number === null ? undefined : this.byNumber.get(number);
  }

  byOrgNumber(orgNumber: number): Company | undefined {
    return this.byOrg.get(orgNumber);
  }
}
