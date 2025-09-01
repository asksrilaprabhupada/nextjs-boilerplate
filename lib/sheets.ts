// lib/sheets.ts
import { google } from "googleapis";

const scopes = ["https://www.googleapis.com/auth/spreadsheets"];

function getAuth() {
  const email = process.env.GOOGLE_SA_EMAIL!;
  const key = (process.env.GOOGLE_SA_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  return new google.auth.JWT(email, undefined, key, scopes);
}

export async function appendRow(opts: {
  spreadsheetId: string;
  values: (string | number | null)[];
}) {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: opts.spreadsheetId,
    range: "A1",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [opts.values] },
  });
}
