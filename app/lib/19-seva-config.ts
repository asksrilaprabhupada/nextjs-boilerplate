/**
 * 19-seva-config.ts — Support-the-seva (donation) details
 *
 * Single source for the account rows shown in the "Support the seva" modal,
 * split by region: givers in India see Account Number / IFSC / UPI, everyone
 * else sees IBAN / BIC-SWIFT. Any row left with an empty `value` renders as a
 * greyed "Add in project" placeholder with its Copy button inert, so the modal
 * stays honest until the real details exist.
 *
 * TODO(owner): fill in the real values below. No other file needs to change —
 * a filled row automatically turns solid and its Copy button starts working.
 */

export type SevaRegion = "india" | "intl";

export interface SevaRow {
  key: string;
  label: string;
  /** Empty string = not yet supplied; the modal shows "Add in project". */
  value: string;
}

export const SEVA_REGIONS: { key: SevaRegion; label: string }[] = [
  { key: "india", label: "India" },
  { key: "intl", label: "International" },
];

export const SEVA_ROWS: Record<SevaRegion, SevaRow[]> = {
  india: [
    { key: "name", label: "Account Name", value: "" },
    { key: "acct", label: "Account Number", value: "" },
    { key: "ifsc", label: "IFSC Code", value: "" },
    { key: "upi", label: "UPI ID", value: "" },
  ],
  intl: [
    { key: "holder", label: "Account Holder", value: "" },
    { key: "iban", label: "IBAN", value: "" },
    { key: "swift", label: "BIC / SWIFT", value: "" },
    { key: "bank", label: "Bank Name", value: "" },
  ],
};

/** True while not one row anywhere carries a real value — drives the honest hint line. */
export const SEVA_IS_PLACEHOLDER = Object.values(SEVA_ROWS)
  .flat()
  .every((row) => !row.value);
