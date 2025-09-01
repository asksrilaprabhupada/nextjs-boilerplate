// lib/sheets.ts
import { google } from "googleapis";

function getJwtClient() {
  const email = process.env.GOOGLE_SA_EMAIL!;
  const key = (process.env.GOOGLE_SA_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  // New signature: pass an options object
  return new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

/**
 * Append a single row to the FIRST sheet in the spreadsheet.
 * Values should be a flat array: [ts, name, email, ...]
 */
export async function appendRow(opts: {
  spreadsheetId: string;
  values: (string | number | boolean | null | undefined)[];
}) {
  const { spreadsheetId, values } = opts;
  const auth = getJwtClient();
  const sheets = google.sheets({ version: "v4", auth });

  // Get the first sheet name to be safe (works even if user renamed the sheet)
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetName =
    meta.data.sheets?.[0]?.properties?.title || "Sheet1";

  // Append at A1 (Google will insert a new row at the end)
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [values],
    },
  });
}
