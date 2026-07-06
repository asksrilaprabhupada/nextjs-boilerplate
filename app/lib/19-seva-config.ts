/**
 * 19-seva-config.ts — Support-the-seva (donation) details
 *
 * Single source for the bank/UPI rows shown in the "Support the seva" modal.
 * The values below are PLACEHOLDERS — the owner replaces them with the real
 * account and flips `isPlaceholder` to false; that one flag switches the modal
 * from FAKE-labelled/copy-disabled to live. Nothing else needs to change.
 *
 * TODO(owner): fill in the real account details, then set isPlaceholder: false.
 */

export interface SevaRow {
  label: string;
  value: string;
}

export const SEVA = {
  /** While true: every value renders with a " (FAKE)" suffix, the do-not-send
   *  notice shows, and the Copy buttons are disabled. */
  isPlaceholder: true,
  notice: "Placeholder details — please do not send money yet.",
  rows: [
    { label: "Account name", value: "Ask Śrīla Prabhupāda Seva" },
    { label: "Account number", value: "0000 0000 0000" },
    { label: "IFSC", value: "BANK0000000" },
    { label: "UPI", value: "seva@upi" },
  ] as SevaRow[],
} as const;
